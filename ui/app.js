(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const token = $('meta[name="app-token"]').content;
  const form = $('#setup-form');
  const profileNames = { archivos: 'Leer, crear y editar archivos', lectura: 'Solo consultar archivos', proyecto: 'Archivos y comandos de desarrollo' };
  const statusNames = { stopped: 'Desconectado', starting: 'Conectando…', running: 'Conexión activa', error: 'Necesita atención' };
  const stepTitles = ['#folder-title', '#permissions-title', '#connection-title'];
  let state = null;
  let step = 1;
  let editing = false;
  let initialized = false;
  let online = false;
  let closed = false;
  let closing = false;
  let pendingAction = false;
  let cancelPending = false;
  let panicPending = false;
  let awaitingSetup = false;
  let lifecycle = 0;
  let stateEpoch = 0;
  let pollTimer;
  let pollInFlight = false;
  let toastTimer;
  let eventSignature = '';
  let approvalSignature = '';
  let previousOperationBusy = false;
  let previousRuntimeState = '';

  function selected(name) {
    return form.querySelector(`input[name="${name}"]:checked`).value;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  }

  function updateText(selector, value) {
    const node = $(selector);
    if (node.textContent !== value) node.textContent = value;
  }

  function showToast(message) {
    if (closed || closing) return;
    clearTimeout(toastTimer);
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 9000);
  }

  function showError(error, title = 'No se pudo completar') {
    $('#action-error-title').textContent = title;
    $('#action-error-text').textContent = error instanceof Error ? error.message : String(error);
    $('#action-error').hidden = false;
  }

  function clearError() {
    $('#action-error').hidden = true;
    $('#form-error').hidden = true;
  }

  async function request(path, data) {
    const options = {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'X-MCP-Token': token },
      credentials: 'same-origin',
      cache: 'no-store',
    };
    if (data !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    } else {
      options.signal = AbortSignal.timeout(10000);
    }
    let response;
    try {
      response = await fetch(path, options);
    } catch {
      throw new Error('La app no responde. Comprueba que Gemini PC siga abierto e inténtalo de nuevo.');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('La app devolvió una respuesta inesperada. Vuelve a abrir Gemini PC.');
    }
    if (!response.ok || result.ok === false) {
      const message = typeof result.error === 'string' ? result.error : result.error?.message;
      throw new Error(message || 'No se pudo completar la acción. Revisa la actividad e inténtalo otra vez.');
    }
    return result;
  }

  function navigate() {
    const requested = location.hash.slice(1);
    if (requested === 'main') return;
    const page = ['inicio', 'actividad', 'ayuda'].includes(requested) ? requested : 'inicio';
    $$('.page').forEach(node => { node.hidden = node.id !== `page-${page}`; });
    $$('.nav-item').forEach(node => {
      const active = node.dataset.page === page;
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    $('#page-label').textContent = { inicio: 'Inicio', actividad: 'Actividad', ayuda: 'Ayuda' }[page];
  }

  function setStep(next, focus = true) {
    step = next;
    $('#form-error').hidden = true;
    $$('[data-form-step]').forEach(node => { node.hidden = Number(node.dataset.formStep) !== step; });
    $$('[data-step-indicator]').forEach(node => {
      const current = Number(node.dataset.stepIndicator);
      node.classList.toggle('active', current === step);
      node.classList.toggle('complete', current < step);
      if (current === step) node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
      const number = node.querySelector('.step-number');
      number.replaceChildren(current < step ? icon('check') : document.createTextNode(String(current)));
    });
    $('#previous-step').hidden = step === 1;
    $('#step-caption').textContent = `Paso ${step} de 3`;
    $('#next-step-label').textContent = step === 3 ? 'Preparar conexión' : 'Continuar';
    if (focus) $(stepTitles[step - 1]).focus({ preventScroll: true });
  }

  function configureFields(targetChanged = false) {
    const target = selected('target');
    const web = target === 'web';
    if (targetChanged) $('#mode').value = web ? 'ngrok' : 'local';
    const mode = $('#mode').value;
    $('#web-connection-fields').hidden = !web;
    $('#mode-field').hidden = !web;
    $('#ngrok-field').hidden = !web || mode !== 'ngrok';
    $('#base-url-field').hidden = !web || mode !== 'direct';
    $('#local-mode-hint').hidden = !web || mode !== 'local';
    $('#ngrok-saved').hidden = !state?.ngrok?.configured;
    $('#ngrok-optional').hidden = !state?.ngrok?.configured;
    $('#account-saved').hidden = !state?.account?.configured;
    $('.account-section').hidden = !web;
    $('#account-fields').hidden = Boolean(state?.account?.configured && !$('#change-account').checked);
    $('#account-name').textContent = state?.account?.username ? `Usuario: ${state.account.username}` : 'Se conservará tu acceso actual.';
    $('#command-consent').hidden = selected('profile') !== 'proyecto';
  }

  function hydrateForm() {
    const config = state.config || {};
    $('#workspace').value = config.workspace || '';
    $('#port').value = config.port || 3000;
    $('#base-url').value = config.baseUrl || '';
    const profile = ['lectura', 'archivos', 'proyecto'].includes(config.profile) ? config.profile : 'archivos';
    const target = config.target === 'cli' ? 'cli' : 'web';
    form.querySelector(`input[name="profile"][value="${profile}"]`).checked = true;
    form.querySelector(`input[name="target"][value="${target}"]`).checked = true;
    $('#mode').value = ['ngrok', 'direct', 'local'].includes(config.mode) ? config.mode : (target === 'cli' ? 'local' : 'ngrok');
    $('#allow-commands').checked = false;
    $('#change-account').checked = false;
    $('#username').value = state.account?.username || '';
    $('#password').value = '';
    $('#authtoken').value = '';
    configureFields();
    setStep(1, false);
  }

  function setBusyControls() {
    const busy = pendingAction || closing || closed || Boolean(state?.operation?.busy);
    const running = ['running', 'starting'].includes(state?.runtime?.state);
    form.querySelectorAll('input, select, button').forEach(node => { node.disabled = busy || !online; });
    $('#cancel-edit').disabled = busy;
    $('#edit-config').disabled = busy || running || !online;
    $('#edit-config').title = running ? 'Detén la conexión para cambiar la configuración.' : '';
    $('#start-button').disabled = busy || !online;
    $('#stop-button').disabled = busy || !online;
    $('#doctor-button').disabled = busy || !online;
    $('#install-cli').disabled = busy || !online;
    $('#cancel-operation').disabled = cancelPending || closing || closed || !online;
    $('#refresh-activity').disabled = pollInFlight || !online;
    $('#copy-endpoint').disabled = !$('#endpoint').value;
    $('#shutdown-button').disabled = pendingAction || closing || closed || !online;
    $('#shutdown-confirm').disabled = pendingAction || closing || closed;
    $('#panic-button').disabled = panicPending || closed;
    $('#panic-button').setAttribute('aria-busy', String(panicPending));
    $('#panic-button-label').textContent = panicPending ? 'Cortando…' : 'Cortar todo';
    $$('.approval-actions button').forEach(button => { button.disabled = busy || !online || button.dataset.blocked === 'true'; });
    if (awaitingSetup) $('#next-step-label').textContent = 'Preparando conexión…';
    else $('#next-step-label').textContent = step === 3 ? 'Preparar conexión' : 'Continuar';
  }

  function paintEvents(events) {
    const nextSignature = JSON.stringify(events);
    if (nextSignature === eventSignature) return;
    eventSignature = nextSignature;
    $('#events-empty').hidden = events.length > 0;
    const list = $('#events-list');
    const nodes = [...events].reverse().slice(0, 100).map(event => {
      const row = element('li', 'event');
      row.dataset.kind = event.kind || 'info';
      row.append(element('span', 'event-dot'), element('p', '', event.message || 'Actividad registrada'));
      const date = new Date(event.time);
      const time = element('time', '', Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }));
      if (!Number.isNaN(date.valueOf())) {
        time.dateTime = date.toISOString();
        time.title = date.toLocaleString('es');
      }
      row.append(time);
      return row;
    });
    list.replaceChildren(...nodes);
  }

  function paintApprovals(approvals) {
    const nextSignature = JSON.stringify(approvals);
    if (nextSignature === approvalSignature) return;
    approvalSignature = nextSignature;
    $('#approval-section').hidden = !approvals.length;
    $('#approval-count').hidden = !approvals.length;
    $('#approval-count').textContent = String(approvals.length);
    $('#approval-count').setAttribute('aria-label', `${approvals.length} acciones pendientes`);
    $('#pending-count').textContent = `${approvals.length} pendiente${approvals.length === 1 ? '' : 's'}`;
    const list = $('#approvals-list');
    const existing = new Map([...list.children].map(card => [card.dataset.approvalId, card]));
    const focusedCard = document.activeElement?.closest('.approval-card');
    const focusedId = focusedCard?.dataset.approvalId;
    const focusedDecision = document.activeElement?.dataset.decision;
    const focusedSummary = document.activeElement?.tagName === 'SUMMARY';
    const nodes = approvals.map(approval => {
      const id = String(approval.id || approval.approvalId);
      const signature = JSON.stringify(approval);
      const previous = existing.get(id);
      if (previous?.dataset.signature === signature) return previous;
      const card = element('article', 'approval-card');
      card.dataset.approvalId = id;
      card.dataset.signature = signature;
      card.append(element('h3', '', approval.tool || approval.action || 'Acción solicitada'));
      if (approval.consequences) card.append(element('p', '', Array.isArray(approval.consequences) ? approval.consequences.join('\n') : approval.consequences));
      if (approval.argsSummary) card.append(element('code', '', typeof approval.argsSummary === 'string' ? approval.argsSummary : JSON.stringify(approval.argsSummary, null, 2)));
      if (approval.details) {
        const details = element('details', 'approval-details');
        details.open = Boolean(previous?.querySelector('details')?.open);
        details.append(element('summary', '', 'Ver acción completa'), element('pre', '', approval.details));
        card.append(details);
      }
      if (approval.reviewTruncated) card.append(element('p', 'approval-warning', 'La acción es demasiado extensa para revisarla completa aquí. Revísala fuera de este panel antes de autorizarla.'));
      if (Array.isArray(approval.affectedPaths) && approval.affectedPaths.length) card.append(element('p', '', `Archivos: ${approval.affectedPaths.join(', ')}`));
      if (approval.expiresAt) {
        const expires = new Date(approval.expiresAt);
        if (!Number.isNaN(expires.valueOf())) card.append(element('p', 'field-hint', `Esta solicitud vence a las ${expires.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}.`));
      }
      const actions = element('div', 'approval-actions');
      for (const [decision, label] of [['approve', 'Permitir una vez'], ['reject', 'Rechazar']]) {
        const button = element('button', `button small ${decision === 'approve' ? 'primary' : 'secondary'}`, label);
        button.type = 'button';
        button.dataset.decision = decision;
        if (decision === 'approve' && approval.reviewTruncated) button.dataset.blocked = 'true';
        button.addEventListener('click', () => act(`/api/approvals/${decision}`, { id: approval.id || approval.approvalId }, decision === 'approve' ? 'Permiso concedido para esta acción.' : 'Solicitud rechazada.'));
        actions.append(button);
      }
      card.append(actions);
      return card;
    });
    for (const [index, node] of nodes.entries()) {
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
    }
    const keep = new Set(nodes);
    for (const child of [...list.children]) if (!keep.has(child)) child.remove();
    if (focusedId && document.activeElement !== focusedCard && !list.contains(document.activeElement)) {
      const replacement = nodes.find(card => card.dataset.approvalId === focusedId);
      const focusTarget = replacement && (focusedDecision
        ? replacement.querySelector(`[data-decision="${focusedDecision}"]`)
        : focusedSummary ? replacement.querySelector('summary') : null);
      (focusTarget || (approvals.length ? $('#approvals-title') : $('#activity-title'))).focus({ preventScroll: true });
    }
  }

  function applyState(next) {
    if (!next || closed) return;
    state = next;
    online = true;
    $('#connection-error').hidden = true;
    $('#loading-panel').hidden = true;
    const busy = Boolean(state.operation?.busy);
    if (!initialized) {
      initialized = true;
      hydrateForm();
    }
    $('#setup-panel').hidden = Boolean(state.configured && !editing);
    $('#dashboard').hidden = !state.configured || editing;
    $('#cancel-edit').hidden = !state.configured;
    $('#setup-eyebrow').textContent = state.configured ? 'A TU MEDIDA' : 'EMPECEMOS';
    $('#setup-title').textContent = state.configured ? 'Ajusta tu conexión' : 'Todo listo en tres pasos';
    $('#version').textContent = state.version ? `Versión ${state.version}` : 'Gemini PC';
    const runtime = state.runtime || {};
    const runtimeState = runtime.state || 'stopped';
    const running = runtimeState === 'running';
    const starting = runtimeState === 'starting';
    const status = statusNames[runtimeState] || 'Desconectado';
    $('#global-status').dataset.state = runtimeState;
    updateText('#global-status-text', status);
    $('#dashboard-status').dataset.state = runtimeState;
    $('#dashboard-status-text').textContent = status;
    $('#dashboard-title').textContent = running ? 'Tu conexión está activa' : starting ? 'Preparando la conexión' : runtimeState === 'error' ? 'Revisemos la conexión' : 'Todo preparado';
    $('#runtime-message').textContent = runtime.message || (running ? 'Gemini ya puede conectarse a tu servidor con los permisos que elegiste.' : 'Inicia la conexión cuando quieras trabajar con Gemini.');
    $('#summary-workspace').textContent = state.config?.workspace || 'Sin carpeta seleccionada';
    $('#summary-profile').textContent = profileNames[state.config?.profile] || 'Permisos configurados';
    $('#summary-target').textContent = state.config?.target === 'cli' ? 'Gemini CLI' : 'Gemini en el navegador';
    $('#endpoint-section').hidden = !running || !runtime.endpoint;
    if ($('#endpoint').value !== (runtime.endpoint || '')) $('#endpoint').value = runtime.endpoint || '';
    $('#start-button').hidden = running || starting || state.config?.target === 'cli';
    $('#stop-button').hidden = !running && !starting;
    $('#install-cli').hidden = state.config?.target !== 'cli';
    $('#operation-banner').hidden = !busy;
    updateText('#operation-label', state.operation?.label || 'Preparando…');
    $('#web-instructions').hidden = state.config?.target === 'cli';
    $('#cli-instructions').hidden = state.config?.target !== 'cli';
    $('#next-steps-title').textContent = state.config?.target === 'cli' ? 'Añade la conexión a Gemini CLI' : 'Ahora, conéctalo en Gemini';
    paintEvents(Array.isArray(state.events) ? state.events : []);
    paintApprovals(Array.isArray(state.approvals) ? state.approvals : []);
    if (previousOperationBusy && !busy && !awaitingSetup) {
      const lastEvent = state.events?.at(-1);
      if (lastEvent?.kind === 'error') showError(lastEvent.message);
    }
    if (previousRuntimeState !== 'error' && runtimeState === 'error' && runtime.message) showError(runtime.message, 'La conexión necesita atención');
    previousOperationBusy = busy;
    previousRuntimeState = runtimeState;
    setBusyControls();
  }

  async function poll() {
    if (closed || closing || pollInFlight) return;
    clearTimeout(pollTimer);
    pollInFlight = true;
    const epoch = stateEpoch;
    try {
      const result = await request('/api/state');
      if (!closing && epoch === stateEpoch) applyState(result.state);
    } catch {
      if (closed || closing || epoch !== stateEpoch) return;
      online = false;
      $('#connection-error').hidden = false;
      updateText('#global-status-text', 'Sin respuesta');
      $('#global-status').dataset.state = 'error';
    } finally {
      pollInFlight = false;
      if (!closed && !closing) {
        setBusyControls();
        pollTimer = setTimeout(poll, document.hidden ? 5000 : 2000);
      }
    }
  }

  async function act(path, payload = {}, successMessage) {
    if (pendingAction || closed || closing) return null;
    const currentLifecycle = lifecycle;
    stateEpoch++;
    clearError();
    pendingAction = true;
    setBusyControls();
    try {
      const result = await request(path, payload);
      if (currentLifecycle !== lifecycle || closed || closing) return null;
      stateEpoch++;
      if (path === '/api/setup') {
        awaitingSetup = false;
        editing = false;
        $('#password').value = '';
        $('#authtoken').value = '';
        showToast(result.state?.config?.target === 'cli' ? 'Configuración guardada. Ya puedes añadirla a Gemini CLI.' : 'Configuración guardada. Ya puedes iniciar la conexión.');
      }
      if (result.state) applyState(result.state);
      if (successMessage) showToast(successMessage);
      return result;
    } catch (error) {
      if (currentLifecycle !== lifecycle || closed || closing) return null;
      if (path === '/api/setup') awaitingSetup = false;
      showError(error);
      return null;
    } finally {
      pendingAction = false;
      setBusyControls();
      if (!closed && !closing) poll();
    }
  }

  function invalid(message, field) {
    $('#form-error').textContent = message;
    $('#form-error').hidden = false;
    if (field) {
      const details = field.closest('details');
      if (details) details.open = true;
      field.focus();
    }
    return false;
  }

  function validateStep() {
    if (step === 1 && !$('#workspace').value.trim()) return invalid('Elige una carpeta de trabajo para continuar.', $('#workspace'));
    if (step === 2 && selected('profile') === 'proyecto' && !$('#allow-commands').checked) return invalid('Para usar el modo de proyecto, confirma que permites ejecutar comandos o elige otro permiso.', $('#allow-commands'));
    if (step !== 3) return true;
    if (selected('target') === 'web') {
      if ($('#mode').value === 'local') return invalid('Gemini en el navegador necesita una dirección pública. Elige ngrok o una dirección HTTPS propia.', $('#mode'));
      if ($('#mode').value === 'ngrok' && !state?.ngrok?.configured && !$('#authtoken').value.trim()) return invalid('Añade tu código de ngrok para crear la dirección de conexión.', $('#authtoken'));
      if ($('#mode').value === 'direct') {
        let validUrl = false;
        try {
          const url = new URL($('#base-url').value.trim());
          validUrl = url.protocol === 'https:' && !url.username && !url.password;
        } catch { /* Report the invalid field below. */ }
        if (!validUrl) return invalid('Escribe una dirección HTTPS válida, por ejemplo https://mcp.ejemplo.com.', $('#base-url'));
      }
    }
    if (selected('target') === 'web' && (!state?.account?.configured || $('#change-account').checked)) {
      if (!$('#username').value.trim()) return invalid('Elige un usuario para proteger esta conexión.', $('#username'));
      if ($('#password').value.length < 12) return invalid('Usa una contraseña de al menos 12 caracteres.', $('#password'));
    }
    const port = Number($('#port').value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return invalid('El puerto debe ser un número entre 1024 y 65535.', $('#port'));
    return true;
  }

  async function submitForm(event) {
    event.preventDefault();
    if (pendingAction || state?.operation?.busy || !validateStep()) return;
    if (step < 3) { setStep(step + 1); return; }
    const changingAccount = selected('target') === 'web' && (!state?.account?.configured || $('#change-account').checked);
    const payload = {
      workspace: $('#workspace').value.trim(),
      profile: selected('profile'),
      target: selected('target'),
      mode: selected('target') === 'cli' ? 'local' : $('#mode').value,
      baseUrl: selected('target') !== 'web' ? '' : $('#mode').value === 'direct'
        ? $('#base-url').value.trim()
        : state?.config?.mode === 'ngrok' && !$('#authtoken').value.trim() ? state.config.baseUrl || '' : '',
      port: Number($('#port').value),
      allowCommands: selected('profile') === 'proyecto' && $('#allow-commands').checked,
    };
    if (changingAccount) {
      payload.username = $('#username').value.trim();
      payload.password = $('#password').value;
    }
    if (selected('target') === 'web' && $('#mode').value === 'ngrok' && $('#authtoken').value.trim()) payload.authtoken = $('#authtoken').value.trim();
    awaitingSetup = true;
    const result = await act('/api/setup', payload);
    if (!result) {
      awaitingSetup = false;
      setBusyControls();
    }
  }

  async function chooseFolder() {
    const result = await act('/api/folder');
    if (result?.path && !result.cancelled) {
      $('#workspace').value = result.path;
      $('#form-error').hidden = true;
    }
  }

  async function copyEndpoint() {
    const endpoint = $('#endpoint');
    if (!endpoint.value) return;
    try {
      await navigator.clipboard.writeText(endpoint.value);
      $('#copy-endpoint span').textContent = 'Copiado';
      showToast('Dirección copiada. Ya puedes pegarla en Gemini.');
      setTimeout(() => { $('#copy-endpoint span').textContent = 'Copiar'; }, 2500);
    } catch {
      endpoint.focus();
      endpoint.select();
      showToast('La dirección está seleccionada. Usa Ctrl+C para copiarla.');
    }
  }

  async function cancelOperation() {
    if (cancelPending || closed || closing) return;
    const currentLifecycle = lifecycle;
    cancelPending = true;
    setBusyControls();
    try {
      const result = await request('/api/cancel', {});
      if (currentLifecycle !== lifecycle || closed || closing) return;
      stateEpoch++;
      if (result.state) applyState(result.state);
    } catch (error) {
      if (currentLifecycle === lifecycle && !closed && !closing) showError(error, 'No se pudo cancelar');
    } finally {
      cancelPending = false;
      setBusyControls();
      poll();
    }
  }

  function openShutdownConfirmation() {
    $('#shutdown-dialog-message').textContent = state?.runtime?.state === 'running' || state?.operation?.busy
      ? 'Se detendrá la conexión con Gemini y cualquier preparación en curso. Puedes volver a abrir la app cuando quieras.'
      : 'Puedes volver a abrir Gemini PC cuando quieras usar la conexión.';
    $('#shutdown-dialog').showModal();
  }

  async function shutdown() {
    if (pendingAction || closed || closing) return;
    const currentLifecycle = ++lifecycle;
    stateEpoch++;
    closing = true;
    pendingAction = true;
    setBusyControls();
    clearTimeout(pollTimer);
    try {
      await request('/api/shutdown', {});
      if (currentLifecycle === lifecycle) showClosed(false);
    } catch (error) {
      if (currentLifecycle !== lifecycle) return;
      closing = false;
      $('#shutdown-dialog').close();
      showError(error, 'No se pudo cerrar la aplicación');
      poll();
    } finally {
      pendingAction = false;
      setBusyControls();
    }
  }

  function showClosed(emergency) {
    closed = true;
    closing = false;
    clearTimeout(pollTimer);
    clearTimeout(toastTimer);
    $('#toast').hidden = true;
    $('#action-error').hidden = true;
    $('#connection-error').hidden = true;
    $('#operation-banner').hidden = true;
    $('#shutdown-dialog').close();
    $('#closed-title').textContent = emergency ? 'Conexión cortada. Aplicación cerrada.' : 'Aplicación cerrada';
    $('#closed-message').textContent = emergency
      ? 'Se detuvo la conexión y se cerró Gemini PC. Puedes cerrar esta pestaña.'
      : 'Puedes cerrar esta pestaña. Abre Gemini PC cuando quieras volver a conectar.';
    $('#closed-dialog').showModal();
    $('#global-status-text').textContent = 'Aplicación cerrada';
    $('#global-status').dataset.state = 'stopped';
    $('#dashboard-status-text').textContent = 'Desconectado';
    $('#dashboard-status').dataset.state = 'stopped';
    $('#password').value = '';
    $('#authtoken').value = '';
  }

  async function panic() {
    if (panicPending || closed) return;
    const currentLifecycle = ++lifecycle;
    stateEpoch++;
    closing = true;
    panicPending = true;
    awaitingSetup = false;
    clearTimeout(pollTimer);
    clearError();
    $('#shutdown-dialog').close();
    $('#panic-help').textContent = 'Deteniendo la conexión y cerrando la app…';
    setBusyControls();
    try {
      await request('/api/panic', {});
      if (currentLifecycle === lifecycle) showClosed(true);
    } catch (error) {
      if (currentLifecycle !== lifecycle) return;
      closing = false;
      $('#panic-help').textContent = 'No se pudo confirmar el cierre. Reintenta.';
      showError(error, 'No se pudo cortar todo');
    } finally {
      panicPending = false;
      setBusyControls();
      if (!closed && !closing) poll();
    }
  }

  form.addEventListener('submit', submitForm);
  form.addEventListener('change', event => {
    if (event.target.name === 'target') configureFields(true);
    else if (event.target.name === 'profile' || event.target.id === 'mode' || event.target.id === 'change-account') configureFields();
    $('#form-error').hidden = true;
  });
  $('#previous-step').addEventListener('click', () => setStep(Math.max(1, step - 1)));
  $('#choose-folder').addEventListener('click', chooseFolder);
  $('#reconnect-button').addEventListener('click', poll);
  $('#refresh-activity').addEventListener('click', poll);
  $('#dismiss-error').addEventListener('click', clearError);
  $('#start-button').addEventListener('click', () => act('/api/start'));
  $('#stop-button').addEventListener('click', () => act('/api/stop'));
  $('#cancel-operation').addEventListener('click', cancelOperation);
  $('#doctor-button').addEventListener('click', async () => {
    const result = await act('/api/doctor');
    if (result) location.hash = 'actividad';
  });
  $('#install-cli').addEventListener('click', () => act('/api/cli/install', {}, 'Solicitud enviada. Revisa Actividad para confirmar la configuración de Gemini CLI.'));
  $('#copy-endpoint').addEventListener('click', copyEndpoint);
  $('#edit-config').addEventListener('click', () => {
    editing = true;
    clearError();
    hydrateForm();
    applyState(state);
    $('#folder-title').focus({ preventScroll: true });
  });
  $('#cancel-edit').addEventListener('click', () => {
    editing = false;
    clearError();
    $('#password').value = '';
    $('#authtoken').value = '';
    applyState(state);
  });
  $$('[data-go-help]').forEach(button => button.addEventListener('click', () => { location.hash = 'ayuda'; }));
  $('#shutdown-button').addEventListener('click', openShutdownConfirmation);
  $('#panic-button').addEventListener('click', panic);
  $('#shutdown-confirm').addEventListener('click', shutdown);
  $('#shutdown-cancel').addEventListener('click', () => { $('#shutdown-dialog').close(); });
  $('#closed-dialog').addEventListener('cancel', event => event.preventDefault());
  window.addEventListener('hashchange', navigate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !closed) poll(); });
  navigate();
  setStep(1, false);
  poll();
})();
