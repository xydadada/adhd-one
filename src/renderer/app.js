const api = window.adhdOne;
const $ = selector => document.querySelector(selector);

const ERROR_MESSAGES = Object.freeze({
  IPC_OPERATION_FAILED: '操作失败，请稍后重试。',
  APP_QUITTING: '应用正在退出，请稍后重试。',
  APP_SNAPSHOT_FAILED: '无法读取应用状态。',
  UNTRUSTED_IPC_SENDER: '请求来源不受信任。',
  WORKSPACE_PICK_FAILED: '无法选择工作区。',
  WORKSPACE_NOT_FOUND: '工作区不存在或已被移除。',
  WORKSPACE_NOT_DIRECTORY: '所选路径不是文件夹。',
  SETTINGS_IO: '应用设置保存失败。',
  SETTINGS_CORRUPT: '应用设置损坏。',
  SETTINGS_LOCKED: '应用设置正在使用中。',
  PATH_NOT_CONFIGURED: '该目录尚未配置。',
  PATH_OPEN_FAILED: '无法打开目录。',
  RUNTIME_NOT_READY: 'Harness 尚未就绪。',
  RUNTIME_RESTART_FAILED: 'Harness 重启失败。',
  UPDATE_CHECK_FAILED: '检查更新失败。',
  UPDATE_NOT_AVAILABLE: '暂无可用更新。',
  UPDATE_CONFIRM_FAILED: '更新操作失败。',
  APP_INSTALL_FAILED: '应用更新安装失败。',
  PORTABLE_UPDATE_DOWNLOAD_ONLY: '便携版更新需要手动完成。',
  DOCTOR_FAILED: 'Provider Doctor 运行失败。',
  DOCTOR_CONFIRMATION_REQUIRED: '需要确认后才能运行深度诊断。',
  DOCTOR_REPORT_MISSING: '暂无可复制的诊断报告。',
  DOCTOR_COPY_FAILED: '诊断报告复制失败。',
  MISSING_CREDENTIAL: '缺少 Provider 凭据。',
  AUTH: 'Provider 鉴权失败。',
  QUOTA: 'Provider 配额不足。',
  RATE_LIMIT: 'Provider 请求过于频繁。',
  MODEL_UNAVAILABLE: '当前模型不可用。',
  TRANSPORT: 'Provider 连接失败。',
  TIMEOUT: 'Provider 请求超时。',
  STREAM_CLOSED: 'Provider 流已关闭。',
  MALFORMED_RESPONSE: 'Provider 返回内容无效。',
  TOOL_ARGUMENT_INVALID: '诊断工具参数无效。',
  TOOL_ESCALATION_REQUIRED: '诊断请求了额外权限。',
  REASONING_UNSUPPORTED: '当前模型不支持推理设置。',
  DSH_PROTOCOL_INCOMPATIBLE: 'Harness 协议不兼容。',
  RPC_FAILED: '远程操作失败。'
});

function knownErrorCode(value) {
  if (!value || typeof value !== 'object') return '';
  const direct = value.code;
  if (typeof direct === 'string' && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, direct)) return direct;
  const legacy = value.message;
  return typeof legacy === 'string' && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, legacy) ? legacy : '';
}

function fixedErrorMessage(value) {
  return ERROR_MESSAGES[knownErrorCode(value)] || ERROR_MESSAGES.IPC_OPERATION_FAILED;
}

function safeJson(value) {
  const sanitize = current => {
    if (Array.isArray(current)) return current.map(sanitize);
    if (!current || typeof current !== 'object') return current;
    const output = {};
    Object.entries(current).forEach(([key, child]) => {
      if (key === 'error') {
        const code = knownErrorCode(child) || 'IPC_OPERATION_FAILED';
        output.error = { code, message: ERROR_MESSAGES[code] };
      } else output[key] = sanitize(child);
    });
    return output;
  };
  return JSON.stringify(sanitize(value), null, 2);
}

function show(page) {
  document.querySelectorAll('.page,nav button').forEach(x => x.classList.remove('active'));
  $('#' + page).classList.add('active');
  document.querySelector(`nav button[data-page="${page}"]`).classList.add('active');
}

function runtime(value) {
  $('#state').textContent = `Harness：${value.state} · ${value.runtimeVersion}`;
  $('#dot').className = `dot ${value.state}`;
}

async function action(button, work, target) {
  button.disabled = true;
  try {
    return await work();
  } catch (error) {
    target.textContent = `操作失败：${fixedErrorMessage(error)}`;
    return undefined;
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('nav button').forEach(button => { button.onclick = () => show(button.dataset.page); });
$('#choose').onclick = function () {
  return action(this, async () => {
    const result = await api.chooseWorkspace();
    if (result.path) {
      $('#workspace').textContent = result.path;
      await api.restartRuntime();
    }
  }, $('#workspace'));
};
$('#restart').onclick = function () { return action(this, () => api.restartRuntime(), $('#state')); };
$('#quit').onclick = function () {
  if (window.confirm('完整退出 ADHD One 并停止 Harness？')) return action(this, () => api.quitApp(), $('#state'));
  return undefined;
};
$('#quick').onclick = function () {
  return action(this, async () => {
    $('#report').textContent = '正在并行诊断…';
    $('#report').textContent = safeJson(await api.runDoctor('quick'));
  }, $('#report'));
};
$('#deep').onclick = function () {
  return action(this, async () => {
    $('#report').textContent = '等待主进程确认…';
    $('#report').textContent = safeJson(await api.runDoctor('deep'));
  }, $('#report'));
};
$('#cancel-doctor').onclick = function () { return action(this, () => api.cancelDoctor(), $('#report')); };
$('#copy').onclick = function () { return action(this, () => api.copyDoctorReport(), $('#report')); };
document.querySelectorAll('[data-update]').forEach(button => {
  button.onclick = function () {
    return action(this, async () => {
      $('#update').textContent = safeJson(await api.checkUpdates(this.dataset.update));
    }, $('#update'));
  };
});
document.querySelectorAll('[data-install]').forEach(button => {
  button.onclick = function () {
    return action(this, async () => {
      await api.confirmUpdate(this.dataset.install);
      $('#update').textContent = '更新已验证；请按提示完成切换。';
    }, $('#update'));
  };
});
api.onRuntimeChanged(runtime);
api.onUpdateChanged(value => { $('#update').textContent = safeJson(value); });
api.onDoctorProgress(value => { $('#report').textContent = `${value.message}\n${$('#report').textContent}`; });
api.onNavigate(show);
api.getAppSnapshot().then(value => {
  runtime(value.runtime);
  $('#workspace').textContent = value.workspace || '尚未选择工作区';
}).catch(error => {
  $('#state').textContent = `操作失败：${fixedErrorMessage(error)}`;
});
