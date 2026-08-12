#!/usr/bin/env bun

import { createInterface } from 'node:readline/promises';
import {
  DogfoodWizardCancelled,
  runDogfoodWizard,
} from '../src/dogfood-wizard.js';

const MACHINE_GUIDANCE = 'The guided dogfood command requires an interactive terminal. For automation use dogfood:series-init, dogfood:init, dogfood:serve, dogfood:prepare, dogfood:render, or dogfood:decision.';

class ReadlineWizardUi {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.readline = null;
    this.actionDepth = 0;
    this.resume();
  }

  resume() {
    if (this.readline) return;
    const readline = createInterface({
      input: this.input,
      output: this.output,
      terminal: true,
      historySize: 0,
      removeHistoryDuplicates: true,
    });
    readline.on('SIGINT', () => {
      if (this.actionDepth > 0) {
        this.write('The confirmed action is still running and cannot be cancelled safely. Waiting for completion.');
        return;
      }
      readline.close();
    });
    this.readline = readline;
  }

  pause() {
    if (!this.readline) return;
    const readline = this.readline;
    this.readline = null;
    readline.close();
  }

  close() {
    this.pause();
  }

  beginAction() {
    this.actionDepth += 1;
  }

  endAction() {
    this.actionDepth = Math.max(0, this.actionDepth - 1);
  }

  write(message) {
    this.output.write(`${message}\n`);
  }

  async question(message) {
    const readline = this.readline;
    if (!readline) throw new DogfoodWizardCancelled();
    try {
      const answer = await readline.question(`${message}: `);
      if (!this.readline) throw new DogfoodWizardCancelled();
      return answer;
    } catch {
      throw new DogfoodWizardCancelled();
    }
  }

  async input(message) {
    return this.question(message);
  }

  async select(message, choices, { recommendedValue } = {}) {
    this.write(message);
    choices.forEach((item, index) => {
      const detail = item.description ? ` — ${item.description}` : '';
      this.write(`  ${index + 1}. ${item.label}${detail}`);
    });
    const recommendedIndex = choices.findIndex((item) => item.value === recommendedValue);
    while (true) {
      const suffix = recommendedIndex >= 0 ? ` [${recommendedIndex + 1}]` : '';
      const answer = (await this.question(`Selection${suffix}`)).trim();
      const index = answer === '' && recommendedIndex >= 0
        ? recommendedIndex
        : Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) {
        return choices[index].value;
      }
      this.write(`Choose a number from 1 through ${choices.length}.`);
    }
  }

  async confirm(message) {
    return (await this.select(message, [
      { value: 'no', label: 'No / cancel' },
      { value: 'yes', label: 'Yes' },
    ])) === 'yes';
  }
}

if (process.argv.length > 2) {
  process.stderr.write(`The guided dogfood command accepts no flags. ${MACHINE_GUIDANCE}\n`);
  process.exitCode = 2;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(`${MACHINE_GUIDANCE}\n`);
  process.exitCode = 2;
} else {
  const ui = new ReadlineWizardUi(process.stdin, process.stdout);
  try {
    await runDogfoodWizard({ ui });
  } catch (error) {
    if (!(error instanceof DogfoodWizardCancelled)) {
      process.stderr.write(`${error?.code ?? 'dogfood-wizard-failed'}: ${error?.message ?? 'guided dogfood failed'}\n`);
      process.exitCode = 1;
    }
  } finally {
    ui.close();
  }
}
