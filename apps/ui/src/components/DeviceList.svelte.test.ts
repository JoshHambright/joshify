/**
 * @vitest-environment jsdom
 */
/**
 * Devices is the "move it to the kitchen" button, so these assert the two ways
 * it could lie: offering a tap that cannot transfer, and drawing a slider for
 * a device that never reported a volume (D-022).
 *
 * `DeviceRow` has no test file of its own on purpose — it is never rendered
 * alone, and testing it through the list keeps the assertions about what is on
 * the screen rather than about the component tree behind it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { PlaybackDevice } from '@joshify/core';
import DeviceList from './DeviceList.svelte';

const device = (over: Partial<PlaybackDevice> = {}): PlaybackDevice => ({
  id: 'dev-1',
  name: 'Kitchen',
  type: 'Speaker',
  isActive: false,
  volumePercent: 55,
  supportsVolume: true,
  ...over,
});

const mount = (devices: readonly PlaybackDevice[], disabled = false) => {
  const transferred: string[] = [];
  const volumes: [string, number][] = [];
  const view = render(DeviceList, {
    devices,
    disabled,
    onTransfer: (deviceId: string) => {
      transferred.push(deviceId);
    },
    onVolume: (deviceId: string, volumePercent: number) => {
      volumes.push([deviceId, volumePercent]);
    },
  });
  return { ...view, transferred, volumes };
};

const rowNames = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.name')].map((node) => node.textContent);

afterEach(cleanup);

describe('the devices list', () => {
  it('names every device on the account', () => {
    mount([device({ id: 'a', name: 'Kitchen' }), device({ id: 'b', name: 'Study' })]);

    expect(screen.getByText('Kitchen')).toBeDefined();
    expect(screen.getByText('Study')).toBeDefined();
  });

  // The one fact this screen exists to state, so it goes first and it is the
  // only thing on the row wearing the album's accent.
  it('puts the playing device first and gives it the lamp', () => {
    const { container } = mount([
      device({ id: 'a', name: 'Attic' }),
      device({ id: 'z', name: 'Zebra', isActive: true }),
    ]);

    expect(rowNames(container)[0]).toBe('Zebra');
    expect(container.querySelectorAll('.lamp')).toHaveLength(1);
  });

  it('says what kind of thing each device is, in a word', () => {
    mount([device({ id: 'a', name: 'Telly', type: 'CastVideo' })]);
    expect(screen.getByText('Cast')).toBeDefined();
  });

  it('moves playback to the device that was tapped', async () => {
    const { transferred } = mount([
      device({ id: 'a', name: 'Kitchen' }),
      device({ id: 'b', name: 'Study' }),
    ]);

    await fireEvent.click(screen.getByRole('button', { name: 'Play on Study' }));
    expect(transferred).toEqual(['b']);
  });

  // Spotify will not accept a restricted device as a transfer target, and an
  // affordance that cannot work is worse than a missing one.
  it('does not offer a tap on a restricted device', () => {
    mount([device({ id: null, name: 'Living Room TV', type: 'TV' })]);

    expect(screen.getByText('Living Room TV')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Moving playback to where it already is achieves nothing, and a control
  // that visibly does nothing reads as broken.
  it('does not offer a tap on the device already playing', () => {
    mount([device({ id: 'a', name: 'Kitchen', isActive: true })]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  // D-022: several Connect types do not report a volume, and a slider drawn at
  // 0 for a device playing at full blast is a confident lie.
  it('draws no slider at all for a device that reports no volume', () => {
    mount([device({ id: 'a', name: 'Receiver', volumePercent: null })]);

    expect(screen.getByText('Receiver')).toBeDefined();
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
  });

  it('draws no slider for a device that will not accept a volume command', () => {
    mount([device({ id: 'a', supportsVolume: false })]);
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
  });

  it('draws a slider only for the devices that report one', () => {
    mount([
      device({ id: 'a', name: 'Kitchen', volumePercent: 55 }),
      device({ id: 'b', name: 'Telly', volumePercent: null, supportsVolume: false }),
    ]);

    expect(screen.queryAllByRole('slider')).toHaveLength(1);
    expect(screen.getByLabelText('Kitchen volume')).toBeDefined();
  });

  it('reports a volume change against the device it belongs to', async () => {
    const { volumes } = mount([
      device({ id: 'a', name: 'Kitchen' }),
      device({ id: 'b', name: 'Study' }),
    ]);

    const slider = screen.getByLabelText('Study volume');
    await fireEvent.pointerDown(slider);
    await fireEvent.input(slider, { target: { value: '30' } });
    await fireEvent.pointerUp(window);

    expect(volumes).toEqual([['b', 30]]);
  });

  // The slider is the one region of the row that keeps its own touches; the
  // rest of the row is a transfer.
  it('does not transfer playback when the slider is the thing being touched', async () => {
    const { transferred } = mount([device({ id: 'a', name: 'Kitchen' })]);

    const slider = screen.getByLabelText('Kitchen volume');
    await fireEvent.pointerDown(slider);
    await fireEvent.input(slider, { target: { value: '30' } });
    await fireEvent.pointerUp(window);

    expect(transferred).toEqual([]);
  });

  // A free account: Spotify refuses every /me/player write, so nothing here
  // can work and nothing here pretends it can.
  it('offers no transfer and no volume when every control is off', () => {
    mount([device({ id: 'a', name: 'Kitchen' })], true);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Kitchen volume').disabled).toBe(true);
  });

  // An account with nothing visible is an ordinary Tuesday, not a fault.
  it('explains an empty list rather than showing a fault or a spinner', () => {
    const { container } = mount([]);

    expect(screen.getByText(/Open Spotify anywhere/)).toBeDefined();
    expect(container.textContent).not.toMatch(/error|failed|loading/i);
  });

  // Two restricted devices share a null id, so a list keyed on the id alone
  // would reuse one row's DOM for the other and show the wrong name.
  it('keeps two devices with no id apart', () => {
    const { container } = mount([
      device({ id: null, name: 'Living Room TV', type: 'TV' }),
      device({ id: null, name: 'Garage', type: 'Speaker' }),
    ]);

    expect(rowNames(container).sort()).toEqual(['Garage', 'Living Room TV']);
  });
});
