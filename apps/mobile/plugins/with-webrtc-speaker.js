const { withAppDelegate } = require("expo/config-plugins");
const { mergeContents } = require("@expo/config-plugins/build/utils/generateCode");

// Configure WebRTC before it opens audio. Unlike a forced port override, this lets iOS route to a headset.
function configureSpeaker(contents) {
  const imports = mergeContents({
    src: contents,
    newSrc: "import WebRTC\nimport AVFoundation",
    tag: "openbot-webrtc-audio-imports",
    anchor: /^internal import Expo$/m,
    offset: 1,
    comment: "//",
  }).contents;
  return mergeContents({
    src: imports,
    newSrc: `    let audioConfig = RTCAudioSessionConfiguration.webRTC()
    audioConfig.categoryOptions.insert(.defaultToSpeaker)
    RTCAudioSessionConfiguration.setWebRTC(audioConfig)`,
    tag: "openbot-webrtc-speaker",
    anchor: /\) -> Bool \{/,
    offset: 1,
    comment: "//",
  }).contents;
}

module.exports = (config) =>
  withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") throw new Error("WebRTC audio requires a Swift AppDelegate.");
    mod.modResults.contents = configureSpeaker(mod.modResults.contents);
    return mod;
  });

module.exports.configureSpeaker = configureSpeaker;
