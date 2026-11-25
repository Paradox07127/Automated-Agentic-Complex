// The 天气 rows' loop (src/main/renderer/weather.ts) against a fake link and a fake clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSave } from '../src/common/settings.ts';
import type { LinkEvent } from '../src/main/renderer/link.ts';
import { WEATHER_TIMING, WeatherDriver } from '../src/main/renderer/weather.ts';

class Clock {
  t = 0;
  private timers: { at: number; fire: () => void; live: boolean }[] = [];
  schedule = (seconds: number, fire: () => void) => {
    const timer = { at: this.t + seconds, fire, live: true };
    this.timers.push(timer);
    return () => { timer.live = false; };
  };
  get pending(): number[] { return this.timers.filter((x) => x.live).map((x) => x.at - this.t); }
  advance(seconds: number) {
    const end = this.t + seconds;
    for (;;) {
      const next = this.timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      this.t = next.at;
      next.fire();
    }
    this.t = end;
  }
}

function rig(settings: Record<string, unknown>) {
  const sent: { req: number; character: string; input: Record<string, unknown> }[] = [], logs: string[] = [];
  let listener: ((e: LinkEvent) => void) | null = null;
  const link = {
    connected: true, currentCharacter: 'jsspsi' as string | null, accept: true,
    sendSetPresentation(req: number, character: string, input: Record<string, unknown>) {
      if (this.accept) sent.push({ req, character, input });
      return this.accept;
    },
    on(l: (e: LinkEvent) => void) { listener = l; return () => { listener = null; }; },
  };
  const clock = new Clock();
  const driver = new WeatherDriver({ settings: () => settings, link, log: (l) => logs.push(l), schedule: clock.schedule });
  const emit = (e: LinkEvent) => listener!(e);
  return { sent, logs, link, clock, driver, emit, settings };
}

test('a hello with rain saved sends rain for an hour and again before the hour runs out', () => {
  const r = rig({ render_weather: 'rain', render_weather_intensity: 0.8 });
  r.emit({ kind: 'character', event: { kind: 'current', id: 'jsspsi' } });
  assert.deepEqual(r.sent, [{ req: 0, character: 'jsspsi', input: { weather: { condition: 'rain', intensity: 0.8 }, valid_for_seconds: 3600 } }]);
  assert.deepEqual(r.clock.pending, [WEATHER_TIMING.renew]);
  assert.ok(WEATHER_TIMING.renew < WEATHER_TIMING.hold);
  r.clock.advance(WEATHER_TIMING.renew);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1]!.req, 1);
  assert.deepEqual(r.clock.pending, [WEATHER_TIMING.renew]);
});

test('clear saved: nothing at hello; a save to clear after snow sends clear once and stops renewing', () => {
  const r = rig({});
  r.emit({ kind: 'character', event: { kind: 'current', id: 'jsspsi' } });
  assert.equal(r.sent.length, 0);
  r.settings.render_weather = 'snow';
  r.driver.saved();
  assert.deepEqual(r.sent.at(-1)!.input.weather, { condition: 'snow', intensity: 0.6 });
  r.settings.render_weather = 'clear';
  r.driver.saved();
  assert.deepEqual(r.sent.at(-1)!.input, { weather: { condition: 'clear', intensity: 0 }, valid_for_seconds: 3600 });
  assert.deepEqual(r.clock.pending, []);
  r.driver.saved();
  assert.equal(r.sent.length, 2);
});

test('a character switch sends the weather to the new character; a value config.json does not accept reads as the default', () => {
  const r = rig({ render_weather: 'hail', render_weather_intensity: 7 });
  r.emit({ kind: 'character', event: { kind: 'current', id: 'jsspsi' } });
  assert.deepEqual(r.sent, []);
  r.settings.render_weather = 'snow';
  r.link.currentCharacter = 'pelica';
  r.emit({ kind: 'character', event: { kind: 'changed', id: 'pelica' } });
  assert.deepEqual(r.sent, [{ req: 0, character: 'pelica', input: { weather: { condition: 'snow', intensity: 0.6 }, valid_for_seconds: 3600 } }]);
});

test('not sent while disconnected; a lost link stops renewing; the next hello sends it again', () => {
  const r = rig({ render_weather: 'rain' });
  r.link.connected = false;
  r.driver.saved();
  assert.deepEqual(r.sent, []);
  r.link.connected = true;
  r.emit({ kind: 'character', event: { kind: 'current', id: 'jsspsi' } });
  assert.equal(r.sent.length, 1);
  r.emit({ kind: 'lost', reason: 'eof' });
  assert.deepEqual(r.clock.pending, []);
  r.emit({ kind: 'character', event: { kind: 'current', id: 'jsspsi' } });
  assert.equal(r.sent.length, 2);
});

test('a refused send is not counted as sent; a rejected presentation_state is logged', () => {
  const r = rig({ render_weather: 'rain' });
  r.link.accept = false;
  r.driver.saved();
  assert.deepEqual(r.clock.pending, []);
  r.link.accept = true;
  r.settings.render_weather = 'clear';
  r.driver.saved();
  assert.deepEqual(r.sent, []);
  r.driver.state({ req: 3, character: 'jsspsi', phase: 'rejected', reason: 'weather_not_prepared' });
  r.driver.state({ req: 4, character: 'jsspsi', phase: 'applied', frame: 9 });
  assert.deepEqual(r.logs, ['weather rejected req=3 character=jsspsi reason=weather_not_prepared']);
});

test('saving 天气 or 强度 plans the weather effect, and neither restarts her', () => {
  for (const changes of [{ render_weather: 'rain' }, { render_weather_intensity: 0.3 }] as Record<string, string | number>[]) {
    const plan = planSave({}, null, changes);
    assert.deepEqual(plan.effects, [{ kind: 'weather' }]);
    assert.equal(plan.restart, 'none');
  }
});
