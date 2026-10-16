// The audience window of the presenter view: shows the slides full screen and
// follows the presenter's window over a BroadcastChannel.
import { h } from '../../../kit/dom.js';
import { Show } from '../show.js';

const id = new URLSearchParams(location.search).get('ch') || '';
const channel = new BroadcastChannel(`snake-slides-${id}`);
const root = h('div.audience');
document.body.append(root);
document.title = 'Slide show';
let show = null;

channel.onmessage = (m) => {
  const d = m.data;
  if (d.type === 'deck') {
    if (show) show.end();
    show = new Show({ pres: d.pres, root, index: d.state.index, controls: false, audience: true });
    show.apply(d.state);
  } else if (d.type === 'state' && show) show.apply(d.state);
  else if (d.type === 'end') window.close();
};
channel.postMessage({ type: 'hello' });

// Keys pressed on this screen drive the presenter's window.
window.addEventListener('keydown', (e) => {
  channel.postMessage({ type: 'key', key: e.key });
  e.preventDefault();
});
root.addEventListener('click', () => channel.postMessage({ type: 'key', key: 'ArrowRight' }));
