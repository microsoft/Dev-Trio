const vscode = acquireVsCodeApi();
const __rawData = document.getElementById('__INIT_DATA__');
const DATA = __rawData ? JSON.parse(__rawData.textContent) : { memory: '', roadmap: '', initialTab: 'memory' };

let currentTab = DATA.initialTab === 'roadmap' ? 'roadmap' : 'memory';

const tabMemory = document.getElementById('tabMemory');
const tabRoadmap = document.getElementById('tabRoadmap');
const saveBtn = document.getElementById('saveBtn');
const discardBtn = document.getElementById('discardBtn');
const saveStatus = document.getElementById('saveStatus');

const quill = new Quill('#editor', {
  theme: 'snow',
  modules: {
    toolbar: [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'strike'],
      [{ list: 'ordered' }, { list: 'bullet' }],
      ['blockquote', 'code-block'],
      ['link'],
      ['clean']
    ]
  }
});

function loadContent(markdown) {
  const html = marked.parse(markdown || '');
  quill.setContents([]);
  quill.clipboard.dangerouslyPasteHTML(html);
}

function currentMarkdown() {
  return currentTab === 'memory' ? (DATA.memory || '') : (DATA.roadmap || '');
}

function updateActiveTab() {
  tabMemory.classList.toggle('active', currentTab === 'memory');
  tabRoadmap.classList.toggle('active', currentTab === 'roadmap');
}

tabMemory.addEventListener('click', function () {
  if (currentTab !== 'memory') {
    currentTab = 'memory';
    updateActiveTab();
    loadContent(currentMarkdown());
  }
});

tabRoadmap.addEventListener('click', function () {
  if (currentTab !== 'roadmap') {
    currentTab = 'roadmap';
    updateActiveTab();
    loadContent(currentMarkdown());
  }
});

saveBtn.addEventListener('click', function () {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  const markdown = td.turndown(quill.root.innerHTML);
  vscode.postMessage({ type: 'saveFile', tab: currentTab, content: markdown });
});

discardBtn.addEventListener('click', function () {
  loadContent(currentMarkdown());
});

window.addEventListener('message', function (ev) {
  if (!ev.data) { return; }
  if (ev.data.type === 'saveComplete') {
    saveStatus.classList.remove('hidden');
    setTimeout(function () { saveStatus.classList.add('hidden'); }, 1800);
  } else if (ev.data.type === 'selectTab') {
    currentTab = ev.data.tab === 'roadmap' ? 'roadmap' : 'memory';
    updateActiveTab();
    loadContent(currentMarkdown());
  }
});

updateActiveTab();
loadContent(currentMarkdown());
