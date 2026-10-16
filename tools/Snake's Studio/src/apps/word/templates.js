// Starting points for new documents.
import { h } from '../../kit/dom.js';

const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export const TEMPLATES = [
  { id: 'blank', name: 'Blank document', html: () => '<p><br></p>' },
  {
    id: 'letter', name: 'Letter',
    html: () => `<p style="text-align: right">Your Name<br>123 Your Street<br>Your Town, ST 00000<br>you@example.com</p>
<p>${today()}</p>
<p>Recipient Name<br>Company<br>456 Their Street<br>Their Town, ST 00000</p>
<p>Dear Recipient,</p>
<p>Start your letter here. Say why you are writing in the first paragraph, give the details in the second, and close with what you would like to happen next.</p>
<p>Thank you for your time and consideration.</p>
<p>Sincerely,</p>
<p><br></p><p>Your Name</p>`,
  },
  {
    id: 'resume', name: 'Résumé',
    meta: { page: { size: 'letter', orientation: 'portrait', margins: { top: 0.7, right: 0.8, bottom: 0.7, left: 0.8 } }, footer: { left: '', center: '', right: '' } },
    html: () => `<p class="title">Your Name</p>
<p class="subtitle">Job Title · City, State · you@example.com · (555) 555-0100</p>
<h2>Profile</h2>
<p>Two or three sentences about who you are, what you are good at and what you want to do next.</p>
<h2>Experience</h2>
<h3>Job Title — Company</h3>
<p class="caption">2022 – Present · City</p>
<ul><li>Something you achieved, with a number if you can (cut costs by 20%).</li><li>A responsibility you owned and what came of it.</li><li>A tool, team or project you led.</li></ul>
<h3>Job Title — Company</h3>
<p class="caption">2018 – 2022 · City</p>
<ul><li>Achievement.</li><li>Achievement.</li></ul>
<h2>Education</h2>
<h3>Degree — School</h3>
<p class="caption">2014 – 2018</p>
<h2>Skills</h2>
<table class="tbl-plain"><colgroup><col style="width:340px"><col style="width:340px"></colgroup><tbody><tr><td><ul><li>Skill</li><li>Skill</li><li>Skill</li></ul></td><td><ul><li>Skill</li><li>Skill</li><li>Skill</li></ul></td></tr></tbody></table>`,
  },
  {
    id: 'report', name: 'Report',
    meta: { header: { left: '{title}', center: '', right: '' }, footer: { left: '', center: '', right: 'Page {page} of {pages}' }, title: 'Report Title' },
    html: () => `<p class="title">Report Title</p>
<p class="subtitle">A short line about what this report covers · ${today()}</p>
<div class="toc" contenteditable="false"><p class="toc-title">Contents</p><p>Use References › Update contents after adding headings.</p></div>
<h1>Summary</h1>
<p>The main findings in a few sentences, for readers who only read this part.</p>
<h1>Background</h1>
<p>Why this report was written and what was looked at.</p>
<h1>Findings</h1>
<h2>First finding</h2>
<p>Details, with evidence.</p>
<table class="tbl-green"><colgroup><col style="width:226px"><col style="width:226px"><col style="width:226px"></colgroup><tbody><tr><th>Item</th><th>Before</th><th>After</th></tr><tr><td>Example</td><td>10</td><td>14</td></tr><tr><td>Example</td><td>7</td><td>9</td></tr></tbody></table>
<h2>Second finding</h2>
<p>Details, with evidence.</p>
<h1>Recommendations</h1>
<ol><li>What should happen first.</li><li>What should happen next.</li></ol>`,
  },
  {
    id: 'essay', name: 'Essay',
    meta: { lineHeight: 2, header: { left: '', center: '', right: 'Surname {page}' }, firstPageDifferent: false, font: 'Times New Roman', fontSize: 12 },
    html: () => `<p>Your Name</p><p>Instructor</p><p>Course</p><p>${today()}</p>
<p style="text-align: center">Title of the Essay</p>
<p style="text-indent: 48px">Open with a sentence that draws the reader in, give the background they need, and end the paragraph with your thesis.</p>
<p style="text-indent: 48px">Each body paragraph makes one point that supports the thesis, with evidence and an explanation of why it matters.</p>
<p style="text-indent: 48px">Close by restating the thesis in new words and saying what follows from it.</p>`,
  },
  {
    id: 'notes', name: 'Meeting notes',
    html: () => `<h1>Meeting notes</h1>
<p><b>Date:</b> ${today()}<br><b>Attendees:</b> <br><b>Purpose:</b> </p>
<h2>Agenda</h2>
<ol><li>Topic one</li><li>Topic two</li></ol>
<h2>Notes</h2>
<ul><li><br></li></ul>
<h2>Decisions</h2>
<ul><li><br></li></ul>
<h2>Action items</h2>
<ul class="checklist"><li data-checked="false">Who does what by when</li><li data-checked="false">Who does what by when</li></ul>`,
  },
  {
    id: 'newsletter', name: 'Newsletter',
    html: () => `<p class="title" style="text-align: center">The Newsletter</p>
<p class="subtitle" style="text-align: center">Issue 1 · ${today()}</p>
<hr>
<div class="cols" style="--n: 2"><div class="col"><h2>Lead story</h2><p>Write the most important story here. Keep paragraphs short so they read well in a narrow column.</p><p>Add a picture with Insert › Picture, or drop one in.</p></div><div class="col"><h2>In brief</h2><ul><li>A short item</li><li>Another short item</li><li>One more</li></ul><div class="note"><p><b>Coming up:</b> dates and events go here.</p></div></div></div>`,
  },
  {
    id: 'recipe', name: 'Recipe',
    html: () => `<p class="title">Recipe Name</p>
<p class="subtitle">Serves 4 · Prep 15 min · Cook 30 min</p>
<h2>Ingredients</h2>
<ul class="checklist"><li data-checked="false">Ingredient</li><li data-checked="false">Ingredient</li><li data-checked="false">Ingredient</li></ul>
<h2>Method</h2>
<ol><li>First step.</li><li>Second step.</li><li>Third step.</li></ol>
<div class="note"><p><b>Tip:</b> anything worth knowing.</p></div>`,
  },
];

/** A small picture of a template's first page, for the start screen. */
export function templateThumb(t) {
  const page = h('div.mini-page');
  const doc = h('div.doc.mini-doc');
  doc.innerHTML = t.html();
  page.append(doc);
  // Scale a full Letter page (816 px wide) down to the card.
  new ResizeObserver(() => { doc.style.transform = `scale(${page.clientWidth / 816})`; }).observe(page);
  return page;
}
