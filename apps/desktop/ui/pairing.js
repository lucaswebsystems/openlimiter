/**
 * The Phone panel, and the devices that came out of it.
 *
 * Pairing is a conversation between two screens, and the whole reason it is
 * safe is that the approval happens on this one. So the panel never skips a
 * beat of it: a code is shown with the seconds it has left, a claim is
 * announced by the name the phone gave itself, and the approval is a button a
 * person presses rather than something that happens because a code was
 * scanned.
 *
 * Every state has a drawn shape. Signed out, idle, waiting, claimed, paired,
 * denied, run out, and the two failures. A bare sentence where a state should
 * be is how a person ends up staring at a panel wondering whether it is
 * working, which on a screen with a countdown is the worst possible doubt.
 *
 * Nothing here decides anything about the pairing itself. The code, its life,
 * the phone's name and the phase all come from Rust, which got them from the
 * server. This file draws them and sends four verbs back.
 */
import {
  devicesList,
  deviceRevoke,
  pairingApprove,
  pairingCancel,
  pairingDeny,
  pairingStart,
  pairingStatus,
} from "./backend.js";
import {
  SETTLED_COPY,
  claimHeadline,
  countdownText,
  isSettled,
  pairingFailureSentence,
} from "./pairing-states.js";
import { qrElement } from "./qr.js";

/** How often the panel asks the server what happened, in milliseconds. */
const POLL_INTERVAL = 2_000;

const state = {
  panel: null,
  session: null,
  timer: null,
  message: null,
  signedIn: false,
  onSignIn: null,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined && className !== null) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(id, label, className) {
  const node = element("button", className, label);
  node.type = "button";
  node.id = id;
  return node;
}

function stopPolling() {
  if (state.timer !== null) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

/* ------------------------------------------------------------------ states */

function signedOutState(panel) {
  panel.append(element("strong", null, "Sign in to pair your phone"));
  panel.append(
    element(
      "p",
      "note tight",
      "Pairing hands your phone a read only view of the meters this window already draws. It needs an account so the phone knows whose meters to show.",
    ),
  );
  const actions = element("div", "button-row");
  const signIn = button("phone-sign-in", "Sign in", "primary");
  signIn.addEventListener("click", () => {
    state.onSignIn?.();
  });
  actions.append(signIn);
  panel.append(actions);
}

function idleState(panel) {
  panel.append(element("strong", null, "Your phone"));
  panel.append(
    element(
      "p",
      "note tight",
      "Show a code, scan it with the phone camera, then approve the phone here. The code lasts two minutes and works once.",
    ),
  );
  const actions = element("div", "button-row");
  const start = button("phone-start", "Show a code", "primary");
  start.addEventListener("click", () => void begin());
  actions.append(start);
  panel.append(actions);
}

function pendingState(panel, session) {
  panel.append(element("strong", null, "Scan this with your phone"));
  const figure = element("div", "pair-symbol");
  figure.append(qrElement(session.url, "Pairing code " + session.code));
  panel.append(figure);
  panel.append(element("p", "pair-code mono tracked", session.code));
  const countdown = element("p", "pair-countdown", countdownText(session.secondsRemaining));
  countdown.setAttribute("role", "timer");
  panel.append(countdown);
  panel.append(
    element(
      "p",
      "note tight",
      "Open the camera and point it at the code, or type the eight characters at openlimiter.com/app/pair.",
    ),
  );
  const actions = element("div", "button-row");
  const cancel = button("phone-cancel", "Cancel", null);
  cancel.addEventListener("click", () => void end());
  actions.append(cancel);
  panel.append(actions);
}

function claimedState(panel, session) {
  panel.append(element("strong", null, claimHeadline(session.deviceName)));
  if (session.devicePlatform !== null && session.devicePlatform !== undefined) {
    panel.append(element("p", "note tight", "Platform: " + session.devicePlatform));
  }
  panel.append(
    element(
      "p",
      "note tight",
      "Approve only if that is the phone in your hand. An approved phone can read your meters and nothing else.",
    ),
  );
  const countdown = element("p", "pair-countdown", countdownText(session.secondsRemaining));
  countdown.setAttribute("role", "timer");
  panel.append(countdown);
  const actions = element("div", "button-row");
  const approve = button("phone-approve", "Approve", "primary");
  approve.addEventListener("click", () => void decide(pairingApprove));
  const deny = button("phone-deny", "Deny", "danger");
  deny.addEventListener("click", () => void decide(pairingDeny));
  actions.append(approve, deny);
  panel.append(actions);
}

function settledState(panel, session) {
  const finished = SETTLED_COPY[session.phase];
  const head = element("div", "plan-headline");
  head.append(element("span", "plan-name", finished.title));
  const badge = element("span", "badge", finished.title);
  badge.setAttribute("data-tone", finished.tone);
  head.append(badge);
  panel.append(head);
  panel.append(element("p", "note tight", finished.sentence));
  const actions = element("div", "button-row");
  const again = button("phone-restart", "Show another code", null);
  again.addEventListener("click", () => void begin());
  actions.append(again);
  panel.append(actions);
}

function failureState(panel, sentence) {
  const alert = element("div", "alert");
  alert.append(element("strong", null, "Pairing did not start"));
  alert.append(element("p", null, sentence));
  panel.append(alert);
  const actions = element("div", "button-row");
  const retry = button("phone-retry", "Try again", null);
  retry.addEventListener("click", () => void begin());
  actions.append(retry);
  panel.append(actions);
}

/* --------------------------------------------------------------- rendering */

export function renderPairing() {
  const panel = state.panel;
  if (panel === null) return;
  panel.textContent = "";
  if (!state.signedIn) {
    signedOutState(panel);
    return;
  }
  if (state.message !== null) {
    failureState(panel, state.message);
    return;
  }
  const session = state.session;
  if (session === null) {
    idleState(panel);
    return;
  }
  if (session.phase === "claimed") {
    claimedState(panel, session);
    return;
  }
  if (isSettled(session.phase)) {
    settledState(panel, session);
    return;
  }
  pendingState(panel, session);
}

function adopt(session) {
  state.session = session;
  state.message = null;
  if (isSettled(session.phase)) stopPolling();
  renderPairing();
}

async function poll() {
  const result = await pairingStatus();
  if (!result.ok) {
    stopPolling();
    state.message = pairingFailureSentence(result);
    renderPairing();
    return;
  }
  adopt(result.value);
}

async function begin() {
  stopPolling();
  state.message = null;
  state.session = null;
  const result = await pairingStart();
  if (!result.ok) {
    state.message = pairingFailureSentence(result);
    renderPairing();
    return;
  }
  adopt(result.value);
  state.timer = window.setInterval(() => void poll(), POLL_INTERVAL);
}

async function end() {
  stopPolling();
  await pairingCancel();
  state.session = null;
  state.message = null;
  renderPairing();
}

async function decide(action) {
  const result = await action();
  if (!result.ok) {
    state.message = pairingFailureSentence(result);
    renderPairing();
    return;
  }
  adopt(result.value);
  await renderDevices();
}

/* ----------------------------------------------------------------- devices */

let devicesMount = null;

/**
 * Every device on the account, with the one you are standing at marked.
 *
 * Revoking is the whole undo for a pairing, so it lives beside it rather than
 * three screens away in a settings panel nobody opens twice.
 */
export async function renderDevices() {
  const mount = devicesMount;
  if (mount === null) return;
  mount.textContent = "";
  if (!state.signedIn) {
    mount.append(
      element("p", "note tight", "Sign in to see the devices on your account."),
    );
    return;
  }
  const result = await devicesList();
  if (!result.ok) {
    mount.append(element("p", "note tight", pairingFailureSentence(result)));
    return;
  }
  const devices = Array.isArray(result.value?.devices) ? result.value.devices : [];
  if (devices.length === 0) {
    mount.append(element("p", "note tight", "No device is registered yet."));
    return;
  }
  for (const device of devices) {
    const row = element("div", "device-row");
    const body = element("span", "device-body");
    body.append(element("strong", null, String(device.name ?? device.id ?? "device")));
    body.append(
      element(
        "span",
        null,
        String(device.platform ?? "unknown") +
          (device.current === true ? ", this device" : ""),
      ),
    );
    row.append(body);
    if (device.current === true) {
      const badge = element("span", "badge", "This device");
      badge.setAttribute("data-tone", "ok");
      row.append(badge);
    } else {
      const revoke = element("button", "small danger", "Revoke");
      revoke.type = "button";
      revoke.setAttribute("data-device-revoke", String(device.id ?? ""));
      revoke.addEventListener("click", () => {
        void (async () => {
          revoke.disabled = true;
          await deviceRevoke(String(device.id ?? ""));
          await renderDevices();
        })();
      });
      row.append(revoke);
    }
    mount.append(row);
  }
}

/**
 * Wire the panel once. `signedIn` is pushed in by the window rather than read
 * here, because the account state has one owner and this file is not it.
 */
export function initPairing(options) {
  state.panel = document.getElementById("phone-panel-body");
  devicesMount = document.getElementById("devices-mount");
  state.onSignIn = options?.onSignIn ?? null;
  renderPairing();
}

export function setPairingAccountState(signedIn) {
  const changed = state.signedIn !== signedIn;
  state.signedIn = signedIn === true;
  if (!state.signedIn) {
    stopPolling();
    state.session = null;
    state.message = null;
  }
  if (changed) {
    renderPairing();
    void renderDevices();
  }
}

/** Closing the panel stops the poll. A hidden panel never asks anything. */
export function pairingPanelClosed() {
  stopPolling();
}

/** Opening it resumes one, unless the pairing already finished. */
export function pairingPanelOpened() {
  renderPairing();
  void renderDevices();
  if (
    state.signedIn &&
    state.session !== null &&
    !isSettled(state.session.phase) &&
    state.timer === null
  ) {
    state.timer = window.setInterval(() => void poll(), POLL_INTERVAL);
  }
}
