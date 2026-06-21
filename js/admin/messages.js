(function(){
  'use strict';

  function readyDeps(){ return window.AdminShell && window.CP && CP.Auth && CP.sb && CP.Applications; }
  function waitReady(ms){
    return new Promise((res,rej)=>{
      const start=Date.now();
      (function tick(){
        if(readyDeps()) return res();
        if(Date.now()-start>ms) return rej(new Error('Admin tools failed to load.'));
        setTimeout(tick,80);
      })();
    });
  }

  function render(threads){
    const S = AdminShell;
    const host = document.getElementById('threads');
    if(!Object.keys(threads).length){
      host.innerHTML = '<div class="empty"><svg class="i"><use href="#i-message"/></svg><h3>No messages yet</h3><p>Tenant conversations will appear here.</p></div>';
      return;
    }
    host.innerHTML = Object.entries(threads).map(([appId,t]) => {
      const last = t.msgs[0];
      const name = ((t.app && t.app.first_name)||'')+' '+((t.app && t.app.last_name)||'');
      const msgs = [...t.msgs].reverse().map(m => ''
        + '<div class="msg msg-'+(m.sender||'tenant')+'">'
        +   '<div class="msg-meta">'+S.esc(m.sender_name||m.sender||'—')+' · '+S.fmtRelative(m.created_at)+'</div>'
        +   S.esc(m.message||'')
        + '</div>').join('');
      return ''
        + '<div class="thread" data-app="'+S.esc(appId)+'">'
        +   '<div class="th-head" data-action="toggle-thread">'
        +     '<div style="min-width:0;flex:1">'
        +       '<div class="row-title">'+S.esc(name.trim()||'Applicant')+' <span class="muted text-xs" style="font-family:monospace">'+S.esc(appId)+'</span></div>'
        +       '<div class="row-sub">'+S.esc((t.app && t.app.email)||'')+'</div>'
        +     '</div>'
        +     '<div class="row-meta">'+t.msgs.length+' · '+S.fmtRelative(last.created_at)+'</div>'
        +   '</div>'
        +   '<div class="th-body">'
        +     msgs
        +     '<div class="reply">'
        +       '<textarea class="form-input" data-reply="'+S.esc(appId)+'" placeholder="Type a reply…" maxlength="2000" rows="3"></textarea>'
        +       '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">'
        +         '<small class="muted text-xs" data-reply-count="'+S.esc(appId)+'">0 / 2000</small>'
        +         '<button class="btn btn-primary btn-sm" data-action="send-reply" data-app="'+S.esc(appId)+'">Send</button>'
        +       '</div>'
        +     '</div>'
        +   '</div>'
        + '</div>';
    }).join('');
  }

  async function load(){
    document.getElementById('threads').innerHTML = AdminShell.skeletonRows(3);
    document.getElementById('page-sub').textContent = 'Loading…';
    const { data: msgs, error } = await CP.sb()
      .from('messages')
      .select('*,applications(first_name,last_name,email,app_id)')
      .order('created_at',{ascending:false});
    if(error){
      document.getElementById('threads').innerHTML =
        '<div class="empty"><h3>Could not load</h3><p>'+AdminShell.esc(error.message)+'</p></div>';
      document.getElementById('page-sub').textContent = 'Error';
      return;
    }
    const threads = {};
    (msgs||[]).forEach(m => {
      const id = m.app_id;
      if(!threads[id]) threads[id] = { app: m.applications, msgs: [] };
      threads[id].msgs.push(m);
    });
    document.getElementById('page-sub').textContent = Object.keys(threads).length+' thread'+(Object.keys(threads).length===1?'':'s');
    render(threads);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch(e){
      document.getElementById('threads').innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    const ok = await AdminShell.requireAdmin();
    if(!ok) return;

    AdminShell.on('toggle-thread', (target) => {
      const t = target.closest('.thread');
      if(t) t.classList.toggle('open');
    });

    document.getElementById('threads').addEventListener('input', e => {
      const ta = e.target.closest('textarea[data-reply]');
      if(!ta) return;
      const counter = document.querySelector('[data-reply-count="'+ta.getAttribute('data-reply')+'"]');
      if(counter) counter.textContent = ta.value.length + ' / 2000';
    });
    AdminShell.on('send-reply', async (target) => {
      const appId = target.getAttribute('data-app');
      const ta = document.querySelector('textarea[data-reply="'+appId+'"]');
      if(!ta) return;
      const msg = ta.value.trim();
      if(!msg) return;
      target.disabled = true;
      const res = await CP.Applications.sendMessage(appId, msg, 'admin', 'Choice Properties');
      target.disabled = false;
      if(res.ok){
        ta.value = '';
        const counter = document.querySelector('[data-reply-count="'+appId+'"]');
        if(counter) counter.textContent = '0 / 2000';
        AdminShell.toast('Message sent','success');
        load();
      } else {
        AdminShell.toast('Error: '+res.error,'error');
      }
    });
    AdminShell.on('refresh', () => load());
    load();
  });
})();
