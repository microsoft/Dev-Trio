/**
 * Decision logic for the "Generate notify script" gate.
 *
 * Testing is a STRONG DEFAULT, not a hard gate: generation is never permanently blocked by the
 * absence of a test. The only friction when untested is a confirm modal.
 */

export type GenerateAction = 'generate' | 'confirm';
export type ConfirmResolution = 'generate' | 'focusTest' | 'cancel';

export const GENERATE_ANYWAY = 'Generate anyway';
export const SEND_TEST_FIRST = 'Send test first';

export class GenerateGate {
  private tested = false;

  /** Latches true on the first successful test; a later failure never un-latches it. */
  markTestResult(ok: boolean): void {
    if (ok) {
      this.tested = true;
    }
  }

  get hasSuccessfulTest(): boolean {
    return this.tested;
  }

  /** When the user clicks Generate: proceed directly if tested, else require a confirm. */
  onGenerateClicked(): GenerateAction {
    return this.tested ? 'generate' : 'confirm';
  }

  /** Maps the confirm-modal choice to the next action. */
  onConfirmChoice(choice: string | undefined): ConfirmResolution {
    if (choice === GENERATE_ANYWAY) {
      return 'generate';
    }
    if (choice === SEND_TEST_FIRST) {
      return 'focusTest';
    }
    return 'cancel';
  }
}
