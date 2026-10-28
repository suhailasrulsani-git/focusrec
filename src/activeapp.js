// Which app is in front? Used for the screenshot caption ("Step 3 - Outlook").
// Windows only for now (Win32 calls through koffi). Other systems get null.

const path = require('path');

let api = null;               // null = not loaded yet, false = not available
const names = new Map();      // exe path -> friendly name

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const version = koffi.load('version.dll');
    koffi.pointer('HANDLE', koffi.opaque());
    api = {
      koffi,
      GetForegroundWindow: user32.func('HANDLE __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(HANDLE hWnd, _Out_ uint32_t *pid)'),
      OpenProcess: kernel32.func('HANDLE __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(HANDLE h)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(HANDLE h, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)'),
      GetFileVersionInfoSizeW: version.func('uint32_t __stdcall GetFileVersionInfoSizeW(const char16_t *file, _Out_ uint32_t *handle)'),
      GetFileVersionInfoW: version.func('bool __stdcall GetFileVersionInfoW(const char16_t *file, uint32_t handle, uint32_t len, void *data)'),
      VerQueryValueW: version.func('bool __stdcall VerQueryValueW(void *block, const char16_t *sub, _Out_ void **value, _Out_ uint32_t *len)'),
    };
  } catch {
    api = false;
  }
  return api;
}

// "Microsoft Outlook" from the exe's version info, else "Outlook" from the file name.
function friendlyName(exePath) {
  if (names.has(exePath)) return names.get(exePath);
  const fallback = path.basename(exePath, path.extname(exePath));
  let name = fallback.charAt(0).toUpperCase() + fallback.slice(1).toLowerCase();
  const a = load();
  if (!a) return name;
  try {
    const size = a.GetFileVersionInfoSizeW(exePath, [0]);
    if (size) {
      const block = a.koffi.alloc('uint8_t', size);
      try {
        if (a.GetFileVersionInfoW(exePath, 0, size, block)) {
          const ptr = [null];
          const len = [0];
          const langs = [];
          if (a.VerQueryValueW(block, '\\VarFileInfo\\Translation', ptr, len) && len[0] >= 4) {
            const [lang, cp] = a.koffi.decode(ptr[0], 'uint16_t', 2);
            langs.push(lang.toString(16).padStart(4, '0') + cp.toString(16).padStart(4, '0'));
          }
          langs.push('040904b0', '040904e4');
          for (const l of langs) {
            if (a.VerQueryValueW(block, `\\StringFileInfo\\${l}\\FileDescription`, ptr, len) && len[0] > 1) {
              const desc = a.koffi.decode(ptr[0], 'char16_t', -1).trim();
              if (desc) { name = desc; break; }
            }
          }
        }
      } finally {
        a.koffi.free(block);
      }
    }
  } catch { /* keep the file-name fallback */ }
  names.set(exePath, name);
  return name;
}

// { pid, name } of the window in front, or null.
function foregroundApp() {
  const a = load();
  if (!a) return null;
  try {
    const hwnd = a.GetForegroundWindow();
    if (!hwnd) return null;
    const pid = [0];
    if (!a.GetWindowThreadProcessId(hwnd, pid) || !pid[0]) return null;
    const h = a.OpenProcess(0x1000, false, pid[0]);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (!h) return { pid: pid[0], name: null };
    try {
      const buf = new Uint16Array(1024);
      const size = [buf.length];
      if (!a.QueryFullProcessImageNameW(h, 0, buf, size)) return { pid: pid[0], name: null };
      const exePath = Buffer.from(buf.buffer, 0, size[0] * 2).toString('utf16le');
      return { pid: pid[0], name: friendlyName(exePath) };
    } finally {
      a.CloseHandle(h);
    }
  } catch {
    return null;
  }
}

module.exports = { foregroundApp, friendlyName };
