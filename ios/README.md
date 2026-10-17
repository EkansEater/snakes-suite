# Snake's Master Suite for iPhone and iPad

Every Snake app that can run on an iPhone, in one app: Word, Spreadsheets, Slides, Paint,
Photo, Movie Maker, Player, Code, SoundPad, Screen Recorder, DAW, Converter and Compressor.
They are the suite's own pages (`tools/Snake's Studio/dist`, the same files as the website)
in a web view, opened on the home page that lists them all. The MP3 Converter and the
Recompiler need a computer (or Android, for the MP3 Converter); the home page says so.

- Files open and save through the iPhone's document picker, in place (iCloud Drive,
  On My iPhone, other providers), and stay in the recent list. "Open in Master Suite"
  from Files, Mail or Safari opens a file in the right app (`.snake` archives in the Compressor).
- Printing goes to the iPhone's print sheet (which can also make a PDF).
- Two fingers zoom what is under them; swiping in from the left edge goes back to the list of apps.
- The microphone is used only while recording (DAW, Movie Maker, SoundPad, Screen Recorder).
  iPhones cannot record the screen from an app's page, so the Screen Recorder records sound there.
- Nothing is uploaded: the app has no network use of its own.

The home-screen name is "Master Suite" (an iPhone shortens longer names under the icon).

## Building

Needs a Mac with Xcode 16 and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
(cd "../tools/Snake's Code" && npm ci --ignore-scripts && node build.mjs)
(cd "../tools/Snake's Studio" && npm ci --ignore-scripts && node build.mjs)
rm -rf studio && cp -R "../tools/Snake's Studio/dist" studio && rm -f studio/sw.js
SUITE_VERSION=1.1.6 SUITE_BUILD=1 xcodegen generate
open SnakesMasterSuite.xcodeproj
```

Without a Mac, `.github/workflows/ios.yml` builds it on GitHub's Macs: it checks that the
code builds and leaves `snakes-master-suite-ios-unsigned.ipa` with the run.

## Putting it on an iPhone

Apple only runs signed apps:

- **Free:** sign the unsigned `.ipa` with your own Apple ID using a sideloading tool
  (AltStore or Sideloadly, run from a computer). It has to be signed again every 7 days.
- **$99 a year (Apple Developer Program):** the project can go to TestFlight (testers
  install from a link) or the App Store, signed in the workflow with your certificate.
- **Without installing anything:** the website works on iPhone, and Safari's
  Share → Add to Home Screen gives each app its own icon; once opened it also works offline.
