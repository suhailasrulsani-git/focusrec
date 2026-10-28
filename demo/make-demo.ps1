# Makes the FocusRec demo video. FocusRec records itself while demo.js drives it.
# A natural voice + soft music play out loud and are recorded as PC sound (needs internet for the voice).
# Hands off the mouse while it runs (about 2 minutes). Moving the mouse stops the demo.
param(
    [string]$CopyTo = ''    # folder to copy FocusRec-demo.mp4 into (optional)
)

$electron = Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # set inside VS Code; Electron would run as plain Node

# 0. Voice clips (Microsoft Andrew via Edge). Skipped when every clip still matches lines.js.
Start-Process $electron -ArgumentList "`"$PSScriptRoot\voices.js`"" -Wait
Get-Content "$PSScriptRoot\work\voices.log"
if (-not (Test-Path "$PSScriptRoot\work\voice\voice.json")) { Write-Warning 'No voice clips - stopping.'; return }

# 1. Pictures of the control bar, Hotkeys tab and private panel (they never show in a recording).
Start-Process $electron -ArgumentList "`"$PSScriptRoot\pictures.js`"" -Wait
Get-Content "$PSScriptRoot\work\pictures.log"

# 2. The demo itself.
$demoArgs = @("`"$PSScriptRoot\demo.js`"")
if ($CopyTo) { $demoArgs += "`"--copy-to=$CopyTo`"" }
Start-Process $electron -ArgumentList $demoArgs -Wait
Get-Content "$PSScriptRoot\work\demo.log"
