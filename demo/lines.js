// What the voice says in the demo video, one entry per clip.
// "Focus Rec" is spelt in two words so the voice says it right.
// After changing a line, run voices.js again (make-demo.ps1 does this when a line changed).
module.exports = {
  VOICE: 'Microsoft Andrew Multilingual Online (Natural) - English (United States)',
  LINES: {
    title: "Hi! This is Focus Rec, a small, free screen recorder. It's just one file. Nothing to install.",
    highlight: 'Your cursor gets a soft highlight... and every click shows a little ripple, so people can follow along.',
    zoom1: 'Want a closer look? Press Alt, Shift, Z.',
    zoom2: 'The zoom follows your mouse... up to three times closer.',
    zoom3: 'Press it again to zoom back out.',
    draw: 'You can draw right on the screen. Circle a number, box a field, point with an arrow... then one key clears it all.',
    shot1: 'Now, screenshots. Press Alt, Shift, S, while recording or not.',
    shot2: 'Each one marks your mouse with a red circle, and adds the step, the app name and the time.',
    guide: 'Focus Rec builds the guide for you: a web page, a Word document, and the pictures. Ready to share.',
    extras: 'The control bar, your hotkeys and the private panel... only you can see them. They never show up in the video.',
    end: "That's Focus Rec. Record, zoom, draw and make guides, all from one small file.",
  },
  // Words the demo waits for, to start an action on that word.
  MARKS: {
    zoom2: ['three'],
    zoom3: ['out'],
    draw: ['circle', 'box', 'arrow', 'then', 'clears'],
  },
};
