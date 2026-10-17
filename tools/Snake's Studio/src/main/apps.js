// The apps that run on Snake's Studio. Shared by the main process and the build.
// `open` lists the files each app opens (for its dialogs and file associations);
// `save` the formats it writes.

const docs = { name: 'Documents', exts: ['snakedoc', 'docx', 'html', 'htm', 'md', 'markdown', 'txt', 'rtf', 'odt'] };
const sheets = { name: 'Spreadsheets', exts: ['snakesheet', 'xlsx', 'csv', 'tsv', 'txt'] };
const slides = { name: 'Presentations', exts: ['snakeslides', 'pptx'] };
const images = { name: 'Images', exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico', 'svg', 'avif'] };
const photo = { name: 'Pictures and projects', exts: ['ora', 'psd', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'svg', 'ico'] };
const video = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv'];
const audio = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'mka'];
const media = { name: 'Media', exts: [...video, ...audio] };
const playlists = { name: 'Playlists', exts: ['m3u', 'm3u8', 'pls'] };
const movie = { name: 'Movie projects', exts: ['snakemovie'] };

const APPS = {
  word: {
    name: "Snake's Word", short: 'Word', tagline: 'Word processor',
    open: [docs], spellcheck: true,
  },
  sheets: {
    name: "Snake's Spreadsheets", short: 'Spreadsheets', tagline: 'Spreadsheets',
    open: [sheets],
  },
  slides: {
    name: "Snake's Slides", short: 'Slides', tagline: 'Presentations',
    open: [slides], spellcheck: true,
  },
  paint: {
    name: "Snake's Paint", short: 'Paint', tagline: 'Drawing',
    open: [images],
  },
  photo: {
    name: "Snake's Photo", short: 'Photo', tagline: 'Photo editor',
    open: [photo],
  },
  player: {
    name: "Snake's Player", short: 'Player', tagline: 'Media player',
    open: [media, playlists], media: true,
  },
  movie: {
    name: "Snake's Movie Maker", short: 'Movie Maker', tagline: 'Video editor',
    open: [movie, { name: 'Media', exts: [...video, ...audio, ...images.exts] }], media: true, microphone: true,
  },
};

// The other Snake apps, for the website and the phone apps: browser versions built on the
// same kit. On the desktop and Android each has its own native app (installed by the hub),
// so they are not Studio windows there.
const WEB_APPS = {
  soundpad: { name: "Snake's SoundPad", short: 'SoundPad', tagline: 'Soundboard', open: [{ name: 'Sounds', exts: audio }] },
  screen: { name: "Snake's Screen Recorder", short: 'Screen Recorder', tagline: 'Screen and sound recorder', open: [] },
};

const HOME = { name: "Snake's Studio", short: 'Studio', tagline: 'Office, creative and media apps' };
// The same page is the website's front door: there it is the whole suite.
const WEB_HOME = { name: "Snake's Master Suite", short: 'Master Suite', tagline: 'Every Snake app in one place' };

module.exports = { APPS, WEB_APPS, HOME, WEB_HOME, VIDEO_EXTS: video, AUDIO_EXTS: audio, IMAGE_EXTS: images.exts };
