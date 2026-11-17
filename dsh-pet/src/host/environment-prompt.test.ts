import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { promptEnvironment, setCityProvider } from './environment.ts';
import { resetUapiCache } from './uapi.ts';
import { resetCityCache } from './ip-city.ts';
import { resetWeatherCache } from './weather.ts';

beforeEach(() => {
  setCityProvider(() => undefined);
  resetUapiCache();
  resetCityCache();
  resetWeatherCache();
});
const response = (city: string) =>
  new Response(
    JSON.stringify({
      province: '测试省',
      city,
      weather: '晴',
      weather_icon: '100',
      temperature: 20,
      wind_direction: '西风',
      wind_power: '1级',
      humidity: 40,
      feels_like: 20,
      report_time: '刚刚',
    }),
    { headers: { 'content-type': 'application/json' } },
  );

test('天气永不返回时对话仍在短预算内继续，并发聊天只共享一个查询', async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const start = performance.now();
  const results = await Promise.all([promptEnvironment({ fetchImpl }), promptEnvironment({ fetchImpl })]);
  assert.deepEqual(results, [{}, {}]);
  assert.equal(calls, 1);
  assert.ok(performance.now() - start < 1000);
});

test('天气及时返回时仍保留事实，后续聊天不重复查询', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return response('南昌市');
  }) as typeof fetch;
  assert.equal((await promptEnvironment({ fetchImpl })).city, '南昌市');
  assert.equal((await promptEnvironment({ fetchImpl })).city, '南昌市');
  assert.equal(calls, 1);
});

test('迟到天气可供下次聊天使用，城市变更不会沿用上一城市', async () => {
  let finish: (value: Response) => void = () => {};
  const pending = new Promise<Response>((done) => {
    finish = done;
  });
  const fetchImpl = (() => pending) as typeof fetch;
  assert.deepEqual(await promptEnvironment({ fetchImpl }), {});
  finish(response('南昌市'));
  await new Promise((done) => setTimeout(done, 10));
  assert.equal((await promptEnvironment({ fetchImpl })).city, '南昌市');
  setCityProvider(() => '杭州市');
  const other = (async () => response('杭州市')) as typeof fetch;
  assert.equal((await promptEnvironment({ fetchImpl: other })).city, '杭州市');
});

test('切换城市后的迟到旧查询不会覆盖新城市缓存', async () => {
  let finish: (value: Response) => void = () => {};
  const gate = new Promise<Response>((done) => {
    finish = done;
  });
  const old = promptEnvironment({ city: '南昌市', fetchImpl: (() => gate) as typeof fetch });
  const fetchImpl = (async () => response('杭州市')) as typeof fetch;
  assert.equal((await promptEnvironment({ city: '杭州市', fetchImpl })).city, '杭州市');
  finish(response('南昌市'));
  assert.equal((await old).city, '南昌市');
  assert.equal((await promptEnvironment({ city: '杭州市', fetchImpl })).city, '杭州市');
});
