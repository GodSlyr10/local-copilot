(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');

  let bubble = null; // current assistant bubble (null = start a new one on the next token)
  let raw = '';
  let busy = false;
  const cards = {}; // approval id -> { card, buttons, status }

  // ---- tiny, safe markdown (escape first, then add code / bold / line breaks) ----
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function md(src) {
    return src
      .split('```')
      .map(function (part, i) {
        if (i % 2 === 1) {
          const nl = part.indexOf('\n');
          const code = nl >= 0 ? part.slice(nl + 1) : part;
          return '<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>';
        }
        return esc(part)
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
          .replace(/\n/g, '<br>');
      })
      .join('');
  }

  function scroll() {
    log.scrollTop = log.scrollHeight;
  }
  function add(cls, html) {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    log.appendChild(d);
    scroll();
    return d;
  }

  function setBusy(value) {
    busy = value;
    sendBtn.style.display = value ? 'none' : '';
    stopBtn.style.display = value ? '' : 'none';
    input.disabled = value;
    if (!value) {
      input.focus();
    }
  }

  // ---- approval cards ----
  function addApproval(m) {
    bubble = null;
    const card = add('card', '');
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = m.kind === 'edit' ? 'Apply changes to ' + m.title + '?' : 'Run this command?';
    card.appendChild(title);

    if (m.kind === 'command') {
      const pre = document.createElement('pre');
      pre.textContent = m.title;
      card.appendChild(pre);
    }

    const row = document.createElement('div');
    row.className = 'row';
    const status = document.createElement('span');
    status.className = 'status';
    const buttons = [];

    function button(label, cls, onClick) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.addEventListener('click', onClick);
      row.appendChild(b);
      buttons.push(b);
      return b;
    }
    function decide(approved) {
      buttons.forEach(function (b) {
        b.disabled = true;
      });
      status.textContent = approved ? 'Approved' : 'Rejected';
      vscode.postMessage({ type: 'approval', id: m.id, approved: approved });
    }

    if (m.canViewDiff) {
      button('View diff', 'secondary', function () {
        vscode.postMessage({ type: 'viewDiff', id: m.id });
      });
    }
    button(m.kind === 'edit' ? 'Apply' : 'Run', 'primary', function () {
      decide(true);
    });
    button('Reject', 'secondary', function () {
      decide(false);
    });
    row.appendChild(status);
    card.appendChild(row);
    cards[m.id] = { buttons: buttons, status: status };
  }

  // ---- messages from the extension ----
  window.addEventListener('message', function (event) {
    const m = event.data;
    switch (m.type) {
      case 'user':
        bubble = null;
        add('msg user', esc(m.text).replace(/\n/g, '<br>'));
        break;
      case 'token':
        if (!bubble) {
          raw = '';
          bubble = add('msg bot', '');
        }
        raw += m.text;
        bubble.innerHTML = md(raw);
        scroll();
        break;
      case 'tool': {
        bubble = null;
        const d = add('tool', '');
        d.id = 'tool-' + m.id;
        d.dataset.label = m.label;
        d.textContent = '\u2699 ' + m.label;
        break;
      }
      case 'toolDone': {
        const d = document.getElementById('tool-' + m.id);
        if (d) {
          d.classList.add(m.ok ? 'ok' : 'fail');
          d.textContent = (m.ok ? '\u2713 ' : '\u2717 ') + d.dataset.label;
        }
        break;
      }
      case 'approval':
        addApproval(m);
        break;
      case 'approvalClosed': {
        const c = cards[m.id];
        if (c) {
          c.buttons.forEach(function (b) {
            b.disabled = true;
          });
          c.status.textContent = 'Cancelled';
        }
        break;
      }
      case 'notice':
        bubble = null;
        add('notice', esc(m.text));
        break;
      case 'error':
        bubble = null;
        add('error', esc(m.text).replace(/\n/g, '<br>'));
        break;
      case 'busy':
        setBusy(!!m.value);
        break;
      case 'clear':
        log.innerHTML = '';
        bubble = null;
        showWelcome();
        break;
    }
  });

  // ---- input ----
  function send() {
    const text = input.value.trim();
    if (!text || busy) {
      return;
    }
    input.value = '';
    vscode.postMessage({ type: 'send', text: text });
  }
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function showWelcome() {
    add(
      'notice',
      'Ask about your code, or have me change it. Every file change and command waits for your approval.<br>' +
        'Slash commands: <code>/explain</code> <code>/fix</code> <code>/tests</code> <code>/doc</code> ' +
        '(they use your current selection).'
    );
  }

  showWelcome();
  vscode.postMessage({ type: 'ready' });
})();
