const api=window.adhdOne;const $=s=>document.querySelector(s);
function show(page){document.querySelectorAll('.page,nav button').forEach(x=>x.classList.remove('active'));$('#'+page).classList.add('active');document.querySelector(`nav button[data-page="${page}"]`).classList.add('active')}
function runtime(value){$('#state').textContent=`Harness：${value.state} · ${value.runtimeVersion}`;$('#dot').className=`dot ${value.state}`}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>show(b.dataset.page));
$('#choose').onclick=async()=>{const result=await api.chooseWorkspace();if(result.path){$('#workspace').textContent=result.path;await api.restartRuntime()}};
$('#restart').onclick=()=>api.restartRuntime();
$('#quick').onclick=async()=>{$('#report').textContent='正在并行诊断…';$('#report').textContent=JSON.stringify(await api.runDoctor('quick'),null,2)};
$('#deep').onclick=async()=>{$('#report').textContent='正在运行真实 tool-call 往返…';$('#report').textContent=JSON.stringify(await api.runDoctor('deep'),null,2)};
$('#copy').onclick=()=>api.copyDoctorReport();
document.querySelectorAll('[data-update]').forEach(b=>b.onclick=async()=>{$('#update').textContent=JSON.stringify(await api.checkUpdates(b.dataset.update),null,2)});
api.onRuntimeChanged(runtime);api.onUpdateChanged(v=>$('#update').textContent=JSON.stringify(v,null,2));api.onDoctorProgress(v=>$('#report').textContent=`${v.message}\n${$('#report').textContent}`);api.onNavigate(show);
api.getAppSnapshot().then(v=>{runtime(v.runtime);$('#workspace').textContent=v.workspace||'尚未选择工作区'});
