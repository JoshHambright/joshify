/**
 * @vitest-environment jsdom
 */
/**
 * The reconcile rule itself is proved in `lib/devices.test.ts`, in Node. What
 * needs a DOM is the wiring: that a poll landing mid-drag does not move the
 * thumb, that a drag sends exactly one command when the finger lifts, and that
 * a finger lifting somewhere else on the panel still counts as a release.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import VolumeSlider from './VolumeSlider.svelte';

const mount = (volumePercent = 40) => {
  const sent: number[] = [];
  const view = render(VolumeSlider, {
    volumePercent,
    label: 'Kitchen volume',
    onVolume: (percent: number) => {
      sent.push(percent);
    },
  });
  const slider = screen.getByRole<HTMLInputElement>('slider');
  return { ...view, slider, sent };
};

/** A whole touch: press, drag across the track, lift. */
const drag = async (slider: HTMLInputElement, to: number): Promise<void> => {
  await fireEvent.pointerDown(slider);
  await fireEvent.input(slider, { target: { value: String(to) } });
  await fireEvent.pointerUp(window);
};

afterEach(cleanup);

describe('the volume slider', () => {
  it('shows the polled value', () => {
    const { slider } = mount(40);
    expect(slider.value).toBe('40');
  });

  it('follows the poll while nothing is touching it', async () => {
    const { slider, rerender } = mount(40);
    await rerender({ volumePercent: 65 });

    expect(slider.value).toBe('65');
  });

  // The thumb jumping out from under a finger because a poll landed is the
  // single thing that makes a slider feel broken on a touchscreen.
  it('ignores an incoming poll while a finger is down', async () => {
    const { slider, rerender } = mount(40);

    await fireEvent.pointerDown(slider);
    await fireEvent.input(slider, { target: { value: '80' } });
    await rerender({ volumePercent: 12 });

    expect(slider.value).toBe('80');
  });

  // Fifty commands across one drag would be rude to Spotify and slow on the
  // speaker; the release is the command.
  it('sends exactly one command, on release', async () => {
    const { slider, sent } = mount(40);

    await fireEvent.pointerDown(slider);
    await fireEvent.input(slider, { target: { value: '60' } });
    await fireEvent.input(slider, { target: { value: '70' } });
    expect(sent).toEqual([]);

    await fireEvent.pointerUp(window);
    expect(sent).toEqual([70]);
  });

  // The write has not reached the speaker yet, so a poll still reporting the
  // old value is stale truth, not a correction (D-028).
  it('holds the released value while the poll still reports the old one', async () => {
    const { slider, rerender } = mount(40);
    await drag(slider, 70);
    await rerender({ volumePercent: 40 });

    expect(slider.value).toBe('70');
  });

  it('adopts the poll once it reports something else', async () => {
    const { slider, rerender } = mount(40);
    await drag(slider, 70);
    await rerender({ volumePercent: 25 });

    expect(slider.value).toBe('25');
  });

  // On a 7" panel the finger leaves the track almost every time.
  it('counts a release anywhere on the panel as the end of the drag', async () => {
    const { slider, sent } = mount(40);

    await fireEvent.pointerDown(slider);
    await fireEvent.input(slider, { target: { value: '55' } });
    await fireEvent.pointerUp(document.body);

    expect(sent).toEqual([55]);
  });

  it('treats a cancelled pointer as a release rather than sticking', async () => {
    const { slider, sent } = mount(40);

    await fireEvent.pointerDown(slider);
    await fireEvent.input(slider, { target: { value: '55' } });
    await fireEvent.pointerCancel(window);

    expect(sent).toEqual([55]);
  });

  // A stray tap on the track is not a volume change and must not fire a
  // command at the speaker.
  it('sends nothing when a press lands and lifts without moving', async () => {
    const { slider, sent } = mount(40);

    await fireEvent.pointerDown(slider);
    await fireEvent.pointerUp(window);

    expect(sent).toEqual([]);
  });

  // A keyboard step has no release to wait for: it is a complete gesture.
  it('commits a keyboard step immediately', async () => {
    const { slider, sent } = mount(40);
    await fireEvent.input(slider, { target: { value: '41' } });

    expect(sent).toEqual([41]);
    expect(slider.value).toBe('41');
  });

  it('carries the device name so the control can be identified', () => {
    mount();
    expect(screen.getByLabelText('Kitchen volume')).toBeDefined();
  });

  it('stops listening for a release once it is gone from the screen', async () => {
    const { slider, sent, unmount } = mount(40);

    await fireEvent.pointerDown(slider);
    await fireEvent.input(slider, { target: { value: '60' } });
    unmount();
    await fireEvent.pointerUp(window);

    expect(sent).toEqual([]);
  });

  it('is inert when the account cannot change anything', async () => {
    const sent: number[] = [];
    render(VolumeSlider, {
      volumePercent: 40,
      label: 'Kitchen volume',
      disabled: true,
      onVolume: (percent: number) => {
        sent.push(percent);
      },
    });
    const slider = screen.getByRole<HTMLInputElement>('slider');

    expect(slider.disabled).toBe(true);
    await fireEvent.pointerDown(slider);
    await fireEvent.pointerUp(window);
    expect(sent).toEqual([]);
  });
});
