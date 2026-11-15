/** 独立设置页的录音入口复用桌宠原有的录音状态机，识别结果同步回 React 草稿。 */
import { createHearControl } from '../../shared/chat/hear-control.ts';
import { ROUTE_SEGMENT } from '../../shared/constants.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import type { ChatPanelState } from './types.ts';

/** 只在显式提供语音入口的外壳绑定；换宠物和卸载时释放麦克风与提示计时器。 */
export function usePanelSpeech(rt: ChatPanelRuntime, state: ChatPanelState): void {
  const latest = rt.useRef(state);
  latest.current = state;
  rt.useEffect(() => {
    if (!rt.speechInput) return;
    const input = state.draftRef.current;
    const composer = input?.closest('.pet-chat-composer');
    const button = composer?.querySelector<HTMLButtonElement>('.pet-chat-mic');
    const message = composer?.querySelector<HTMLElement>('.pet-chat-hear-hint');
    if (!input || !button || !message) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (text: string): void => {
      clearTimeout(timer);
      message.textContent = text;
    };
    const hide = (): void => {
      clearTimeout(timer);
      message.textContent = '';
    };
    const control = createHearControl({
      input,
      micBtn: button,
      hearUrl: ROUTE_SEGMENT + '/voice/hear',
      resizeInput: () => latest.current.setDraft(input.value),
      hint: {
        show,
        hide,
        flash: (text) => {
          show(text);
          timer = setTimeout(hide, 5000);
        },
      },
    });
    return () => {
      control.dispose();
      clearTimeout(timer);
    };
  }, [state.petId]);
}
