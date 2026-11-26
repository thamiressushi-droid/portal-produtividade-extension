const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);
const MINUTE = 60_000;

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

async function createHarness(storedValues, now) {
  let fakeNow = now;
  const storage = { ...storedValues };
  const records = [];
  const inactivityEvents = [];
  const alarmListeners = createEvent();
  const startupListeners = createEvent();
  const runtimeMessageListeners = createEvent();
  const tabEvents = {
    onActivated: createEvent(),
    onUpdated: createEvent(),
    onRemoved: createEvent()
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storage[key]]));
          }
          if (typeof keys === "string") {
            return { [keys]: storage[keys] };
          }
          return { ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storage[key];
          }
        }
      }
    },
    alarms: {
      onAlarm: alarmListeners,
      async create() {},
      async clear() {},
      async get() {
        return null;
      }
    },
    idle: {
      onStateChanged: createEvent(),
      async setDetectionInterval() {}
    },
    runtime: {
      id: "test-extension",
      onStartup: startupListeners,
      onMessage: runtimeMessageListeners,
      getManifest: () => ({ version: "1.2.1" })
    },
    tabs: {
      ...tabEvents,
      async get() {
        return null;
      },
      async query() {
        return [];
      },
      async sendMessage() {
        return null;
      }
    },
    scripting: {
      async executeScript() {}
    }
  };
  const context = vm.createContext({
    AbortSignal,
    URL,
    chrome,
    console: { info() {}, warn() {}, error() {}, log() {} },
    crypto: { randomUUID: () => "test-event-id" },
    fetch: async () => ({ ok: false, status: 503, text: async () => "" }),
    indexedDB: {},
    setTimeout,
    clearTimeout,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [fakeNow]));
      }
      static now() {
        return fakeNow;
      }
    }
  });

  vm.runInContext(backgroundSource, context);
  vm.runInContext(`
    salvarRegistro = async (registro) => { globalThis.testRecords.push(registro); };
    enfileirarRequisicao = async (request) => {
      globalThis.testInactivityEvents.push(request);
    };
    enviarEventoInatividade = async (sessao, startedAt, endedAt = null) => {
      globalThis.testInactivityEvents.push({ startedAt, endedAt });
    };
    abrirOutboxDatabase = async () => ({});
    sincronizarOutbox = () => Promise.resolve();
    validarSessaoPersistida = async () => ({ status: "disconnected" });
    enviarHeartbeatSupabase = async () => false;
    atualizarLimiteInatividade = async () => {};
    atualizarConfiguracoesAdministrativas = async () => {};
  `, context);
  context.testRecords = records;
  context.testInactivityEvents = inactivityEvents;
  await vm.runInContext("sessionReady", context);

  return {
    context,
    storage,
    records,
    inactivityEvents,
    setNow(value) {
      fakeNow = value;
    },
    async emitAlarm(alarm) {
      alarmListeners.listeners[0](alarm);
      await vm.runInContext("sessionOperation", context);
    },
    async emitStartup() {
      startupListeners.listeners[0]();
      await vm.runInContext("sessionOperation", context);
    }
  };
}

function session({ start, heartbeat, lastActivity = start, inactive = false }) {
  return {
    tabId: 7,
    url: "https://web.whatsapp.com/",
    userId: "user-1",
    inicio: new Date(start).toISOString(),
    intervalStart: new Date(start).toISOString(),
    lastActivity: new Date(lastActivity).toISOString(),
    lastHeartbeatAt: heartbeat ? new Date(heartbeat).toISOString() : undefined,
    isActive: !inactive,
    ...(inactive
      ? {
          inactivityStartedAt: new Date(lastActivity + 3 * MINUTE).toISOString(),
          inactivityClientEventId: "inactivity-event-1",
          inactivityUserId: "user-1"
        }
      : {})
  };
}

const previousEvening = Date.parse("2026-11-25T17:34:00.000Z");
const nextMorning = Date.parse("2026-11-26T08:36:00.000Z");

test("recovery caps the WhatsApp inactive record at the last confirmed heartbeat", async () => {
  const heartbeat = Date.parse("2026-11-25T17:40:00.000Z");
  const harness = await createHarness(
    {
      activeSession: session({
        start: previousEvening,
        heartbeat,
        lastActivity: previousEvening,
        inactive: true
      }),
      monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() }
    },
    nextMorning
  );

  assert.equal(vm.runInContext("currentSession", harness.context), null);
  assert.equal(harness.records.length, 1);
  assert.equal(Date.parse(harness.records[0].fim), heartbeat);
  assert.ok(harness.records[0].duracaoSegundos < 15 * 60 * 60);
  assert.equal(harness.inactivityEvents.length, 1);
  assert.equal(
    Date.parse(harness.inactivityEvents[0].endedAt),
    heartbeat
  );
});

test("recovery caps the TOTVS inactive record instead of preserving the overnight gap", async () => {
  const start = Date.parse("2026-11-25T18:08:00.000Z");
  const heartbeat = Date.parse("2026-11-25T18:20:00.000Z");
  const harness = await createHarness(
    {
      activeSession: {
        ...session({ start, heartbeat, lastActivity: start, inactive: true }),
        url: "https://totvscrm.app/"
      },
      monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() }
    },
    nextMorning
  );

  assert.equal(harness.records.length, 1);
  assert.equal(Date.parse(harness.records[0].fim), heartbeat);
  assert.ok(harness.records[0].duracaoSegundos < 15 * 60 * 60);
});

test("a two-minute service-worker wake remains within the five-minute tolerance", async () => {
  const heartbeat = nextMorning - 2 * MINUTE;
  const harness = await createHarness(
    {
      activeSession: session({ start: heartbeat - 10 * MINUTE, heartbeat }),
      monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() }
    },
    nextMorning
  );

  assert.ok(vm.runInContext("currentSession", harness.context));
  assert.equal(harness.records.length, 0);
  assert.equal(
    Date.parse(harness.storage.monitorState.lastHeartbeatAt),
    nextMorning
  );
});

for (const durationMinutes of [10, 15 * 60]) {
  const scenario =
    durationMinutes === 15 * 60
      ? "overnight browser close, computer restart, or extension update"
      : `${durationMinutes}-minute hibernation`;
  test(`${scenario} closes at the previous heartbeat`, async () => {
    const heartbeat = nextMorning - durationMinutes * MINUTE;
    const harness = await createHarness(
      {
        activeSession: session({
          start: heartbeat - 10 * MINUTE,
          heartbeat
        }),
        monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() }
      },
      nextMorning
    );

    assert.equal(vm.runInContext("currentSession", harness.context), null);
    assert.equal(Date.parse(harness.records[0].fim), heartbeat);
  });
}

test("a gap exactly at the five-minute tolerance does not interrupt recovery", async () => {
  const heartbeat = nextMorning - 5 * MINUTE;
  const harness = await createHarness(
    {
      activeSession: session({ start: heartbeat - 10 * MINUTE, heartbeat }),
      monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() }
    },
    nextMorning
  );

  assert.ok(vm.runInContext("currentSession", harness.context));
  assert.equal(harness.records.length, 0);
});

test("a legacy persisted session without a heartbeat closes at its last activity", async () => {
  const lastActivity = previousEvening + 45 * MINUTE;
  const harness = await createHarness(
    {
      activeSession: session({
        start: previousEvening,
        lastActivity
      })
    },
    nextMorning
  );

  assert.equal(vm.runInContext("currentSession", harness.context), null);
  assert.equal(Date.parse(harness.records[0].fim), lastActivity);
});

test("an extension update safely closes an old session with a pending inactivity event", async () => {
  const heartbeat = Date.parse("2026-11-25T18:20:00.000Z");
  const harness = await createHarness(
    {
      activeSession: session({
        start: Date.parse("2026-11-25T18:08:00.000Z"),
        heartbeat,
        lastActivity: Date.parse("2026-11-25T18:08:00.000Z"),
        inactive: true
      }),
      monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() }
    },
    nextMorning
  );

  assert.equal(vm.runInContext("currentSession", harness.context), null);
  assert.equal(harness.records.length, 1);
  assert.equal(Date.parse(harness.records[0].fim), heartbeat);
  assert.equal(harness.inactivityEvents.length, 1);
  assert.equal(
    Date.parse(harness.inactivityEvents[0].endedAt),
    heartbeat
  );
});

test("browser startup splits a recovered session at its prior heartbeat", async () => {
  const heartbeat = nextMorning - 2 * MINUTE;
  const harness = await createHarness(
    {
      activeSession: session({
        start: heartbeat - 10 * MINUTE,
        heartbeat
      }),
      monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() }
    },
    nextMorning
  );

  await harness.emitStartup();

  assert.equal(vm.runInContext("currentSession", harness.context), null);
  assert.equal(Date.parse(harness.records[0].fim), heartbeat);
});

test("a delayed inactivity alarm does not create an inactivity event retroactively", async () => {
  const heartbeat = nextMorning - 30_000;
  const start = nextMorning - 10 * MINUTE;
  const harness = await createHarness(
    {
      activeSession: session({ start, heartbeat }),
      monitorState: { lastHeartbeatAt: new Date(heartbeat).toISOString() },
      inactivityThresholdMinutes: 3
    },
    nextMorning
  );

  await harness.emitAlarm({
    name: "portal-session-inactivity",
    scheduledTime: nextMorning - 6 * MINUTE
  });

  assert.equal(vm.runInContext("currentSession", harness.context), null);
  assert.equal(harness.inactivityEvents.length, 0);
  assert.equal(Date.parse(harness.records[0].fim), nextMorning - 6 * MINUTE);
});
