# Snake's Studio for iPhone and iPad

One app with the seven Studio apps (Word, Spreadsheets, Slides, Paint, Photo, Player,
Movie Maker): the desktop Studio's own pages (`tools/Snake's Studio/dist`, the same
files as the website) in a web view, opened on the Studio's home page.

- Files open and save through the iPhone's document picker, in place (iCloud Drive,
  On My iPhone, other providers), and stay in the recent list. "Open in Snake's Studio"
  from Files, Mail or Safari opens a file in the right app.
- Printing goes to the iPhone's print sheet (which can also make a PDF).
- Two fingers zoom what is under them; swiping in from the left edge goes back to the list of apps.
- Nothing is uploaded: the app has no network use of its own.

## Building

Needs a Mac with Xcode 16 and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
(cd "../tools/Snake's Studio" && npm ci --ignore-scripts && node build.mjs)
rm -rf studio && cp -R "../tools/Snake's Studio/dist" studio
STUDIO_VERSION=1.0.1 STUDIO_BUILD=1 xcodegen generate
open SnakesStudio.xcodeproj
```

Without a Mac, `.github/workflows/ios.yml` builds it on GitHub's Macs: it checks that the
code builds and leaves `snakes-studio-ios-unsigned.ipa` with the run.

## Putting it on an iPhone

Apple only runs signed apps:

- **Free:** sign the unsigned `.ipa` with your own Apple ID using a sideloading tool
  (AltStore or Sideloadly, run from a computer). It has to be signed again every 7 days.
- **$99 a year (Apple Developer Program):** the project can go to TestFlight (testers
  install from a link) or the App Store, signed in the workflow with your certificate.
- **Without installing anything:** the website works on iPhone, and Safari's
  Share → Add to Home Screen gives each app its own icon; once opened it also works offline.
