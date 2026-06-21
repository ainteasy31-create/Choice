(function(){
    'use strict';
    let _filter = 'signed';
    let _all = [];

    function pill(s){
      const m = { pending:'pill-warning', scheduled:'pill-info', confirmed:'pill-success', cancelled:'pill-danger' };
      return '<span class="pill '+(m[s]||'pill-warning')+'">'+(s||'pending')+'</span>';
    }
    function fmtMoney(v){ if(v==null) return '—'; return '$'+Number(v).toLocaleString('en-US',{minimumFractionDigits:0}); }

    function card(app){
      const S = AdminShell;
      const name = (app.first_name||'') + ' ' + (app.last_name||'');
      const mi = app.move_in_status || 'pending';
      const actions = [];
      if(mi !== 'confirmed') actions.push('<button class="btn btn-primary btn-sm" data-action="set-mi" data-id="'+S.esc(app.id)+'" data-set="confirmed">✓ Confirm</button>');
      if(mi !== 'scheduled') actions.push('<button class="btn btn-ghost btn-sm" data-action="set-mi" data-id="'+S.esc(app.id)+'" data-set="scheduled">Mark scheduled</button>');
      if(mi !== 'pending')   actions.push('<button class="btn btn-ghost btn-sm" data-action="set-mi" data-id="'+S.esc(app.id)+'" data-set="pending">Reset</button>');
      actions.push('<button class="btn btn-ghost btn-sm" data-action="send-prep" data-app-id="'+S.esc(app.app_id||app.id)+'">Send prep guide</button>');
      actions.push('<button class="btn btn-ghost btn-sm" data-action="edit-mi" data-id="'+S.esc(app.id)+'" data-date="'+S.esc(app.move_in_date_actual||'')+'" data-notes="'+S.esc(app.move_in_notes||'')+'">Date / notes</button>');
      return ''
        + '<div class="mi-card" id="mi-'+S.esc(app.id)+'">'
        +   '<div class="row-flex between" style="align-items:flex-start">'
        +     '<div style="min-width:0">'
        +       '<div class="text-xs muted" style="font-family:monospace">'+S.esc(app.app_id||app.id)+'</div>'
        +       '<div class="row-title">'+S.esc(name.trim()||'Applicant')+'</div>'
        +       '<div class="row-sub">'+S.esc(app.property_address||app.property_id||'—')+'</div>'
        +       '<div style="margin-top:6px">'+pill(mi)+'</div>'
        +     '</div>'
        +     '<div class="row-meta">'
        +       'Lease starts <strong>'+S.fmtDate(app.lease_start_date)+'</strong>'
        +       (app.move_in_date_actual ? '<br>Actual: <strong style="color:var(--success)">'+S.fmtDate(app.move_in_date_actual)+'</strong>' : '')
        +     '</div>'
        +   '</div>'
        +   '<div class="mi-meta">'
        +     '<div><div class="mi-k">Rent</div><div class="mi-v">'+fmtMoney(app.monthly_rent)+'</div></div>'
        +     '<div><div class="mi-k">Deposit</div><div class="mi-v">'+fmtMoney(app.security_deposit)+'</div></div>'
        +     '<div><div class="mi-k">Move-in costs</div><div class="mi-v">'+fmtMoney(app.move_in_costs)+'</div></div>'
        +     '<div><div class="mi-k">Lease signed</div><div class="mi-v">'+S.fmtDate(app.lease_signed_date)+'</div></div>'
        +     '<div><div class="mi-k">Email</div><div class="mi-v" style="font-size:.74rem">'+S.esc(app.email||'—')+'</div></div>'
        +     '<div><div class="mi-k">Phone</div><div class="mi-v">'+S.esc(app.phone||'—')+'</div></div>'
        +   '</div>'
        +   (app.move_in_notes ? '<div class="row-sub"><strong style="color:var(--text)">Notes:</strong> '+S.esc(app.move_in_notes)+'</div>' : '')
        +   '<div class="row-flex" style="gap:8px;flex-wrap:wrap">'+actions.join('')+'</div>'
        + '</div>';
    }

    async function load(){
      const list = document.getElementById('mi-list');
      list.innerHTML = AdminShell.skeletonRows(3, { avatar:false });
      document.getElementById('page-sub').textContent = 'Loading…';
      let filters;
      if(_filter === 'signed' || _filter === 'all_signed') filters = { lease_status: 'co_signed' };
      else filters = { lease_status: 'co_signed', move_in_status: _filter };
      const { ok, data, error } = await CP.Applications.getAll(filters);
      if(!ok){
        list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Error loading</h3><p>'+AdminShell.esc(error||'')+'</p></div>';
        document.getElementById('page-sub').textContent = 'Error';
        return;
      }
      let rows = data || [];
      if(_filter === 'signed') rows = rows.filter(r => r.move_in_status !== 'confirmed');
      _all = rows;
      document.getElementById('page-sub').textContent = rows.length+' record'+(rows.length===1?'':'s');
      if(!rows.length){
        list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-door"/></svg><h3>Nothing here</h3><p>No fully executed leases match this filter.</p></div>';
        return;
      }
      list.innerHTML = rows.map(card).join('');
    }

    async function sendEmail(appId, type){
      const res = await AdminShell.callFn('/send-email', { app_id: appId, type });
      if(!res || !res.ok){
        const msg = (res && res.json && res.json.error) || 'Email request failed';
        throw new Error(msg);
      }
    }

    function readyDeps(){ return window.AdminShell && window.CP && CP.Applications && CP.Auth; }
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

    function bind(){
      AdminShell.on('set-mi', async (target) => {
        const id = target.getAttribute('data-id');
        const set = target.getAttribute('data-set');
        const card = document.getElementById('mi-'+id);
        if(card) card.style.opacity = '.5';
        const { ok, error } = await CP.Applications.updateMoveIn(id, set);
        if(!ok){ AdminShell.toast('Error: '+error,'error'); if(card) card.style.opacity='1'; return; }
        if(set === 'confirmed'){
          const send = await AdminShell.confirm({
            title:'Move-in confirmed', message:'Send move-in confirmation email to tenant?', ok:'Send email', cancel:'Skip'
          });
          if(send){
            const app = _all.find(a => a.id === id);
            try { await sendEmail(app.app_id || id, 'movein_confirmed'); AdminShell.toast('Email sent','success'); }
            catch(e){ AdminShell.toast('Email failed: '+e.message,'error'); }
          }
        }
        load();
      });

      AdminShell.on('send-prep', async (target) => {
        const appId = target.getAttribute('data-app-id');
        const ok = await AdminShell.confirm({ title:'Send prep guide?', message:'Send the Move-In Preparation Guide to this tenant?', ok:'Send' });
        if(!ok) return;
        try { await sendEmail(appId, 'move_in_prep'); AdminShell.toast('Prep guide sent','success'); }
        catch(e){ AdminShell.toast('Failed: '+e.message,'error'); }
      });

      AdminShell.on('edit-mi', async (target) => {
        const id = target.getAttribute('data-id');
        const data = await AdminShell.formSheet({
          title:'Move-in details', submit:'Save',
          fields:[
            { name:'date',  label:'Actual move-in date', type:'date',     value: target.getAttribute('data-date') || '' },
            { name:'notes', label:'Move-in notes',       type:'textarea', value: target.getAttribute('data-notes') || '', rows:4, placeholder:'Key pickup, inspection notes…' }
          ]
        });
        if(!data) return;
        const { ok, error } = await CP.Applications.updateMoveIn(id, undefined, data.date || null, data.notes || null);
        if(!ok){ AdminShell.toast('Error: '+error,'error'); return; }
        AdminShell.toast('Saved','success');
        load();
      });
    }

    document.addEventListener('cp:realtime', () => load().catch(()=>{}));
    document.addEventListener('DOMContentLoaded', async () => {
      try { await waitReady(8000); }
      catch(e){
        document.getElementById('mi-list').innerHTML =
          '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
        return;
      }
      const ok = await AdminShell.requireAdmin();
      if(!ok) return;
      bind();
      AdminShell.on('refresh', () => load());
      document.getElementById('chips').addEventListener('click', e => {
        const c = e.target.closest('.chip');
        if(!c) return;
        document.querySelectorAll('#chips .chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        _filter = c.dataset.mi;
        load();
      });
      load();
    });
  })();
  