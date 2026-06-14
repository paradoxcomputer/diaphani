// Pretty, friendly terminal output for the diaphani CLI.
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';

const accent = chalk.hex('#7c5cff'); // diaphani violet (from "diaphanḗs")
const good = chalk.green;
const bad = chalk.red;
const warnC = chalk.yellow;
const dimC = chalk.dim;

export const ui = {
  c: chalk,
  accent,

  nl() {
    process.stdout.write('\n');
  },

  banner() {
    const title = accent.bold('◇ D I A P H A N I');
    const tagline = chalk.white('Run a Logos node that links you to ') + chalk.bold.white('no one') + chalk.white('.');
    const sub = dimC('Tor onion API  ·  Nym egress  ·  no single party links you');
    console.log(
      boxen(`${title}\n\n${tagline}\n${sub}`, {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: '#7c5cff',
      }),
    );
  },

  heading(msg) {
    console.log('\n' + accent.bold(msg));
  },

  step(msg) {
    console.log(accent('•') + ' ' + msg);
  },
  ok(msg) {
    console.log(good('✓') + ' ' + msg);
  },
  info(msg) {
    console.log(chalk.cyan('ℹ') + ' ' + msg);
  },
  warn(msg) {
    console.log(warnC('!') + ' ' + msg);
  },
  fail(msg) {
    console.log(bad('✗') + ' ' + msg);
  },
  dim(msg) {
    console.log(dimC(msg));
  },

  // key/value line, padded
  kv(key, val, pad = 16) {
    console.log('  ' + dimC((key + ':').padEnd(pad)) + ' ' + val);
  },

  spinner(text) {
    // Use ora's animated spinner only in a real interactive terminal. In
    // pipes, CI, dumb terminals (or under script(1)) ora's raw-mode/stdin
    // handling can stall the event loop, so fall back to plain lines.
    if (process.stdout.isTTY && !process.env.DIAPHANI_PLAIN && !process.env.CI) {
      return ora({ text, color: 'magenta', spinner: 'dots', discardStdin: false });
    }
    return new PlainSpinner(text);
  },

  box(title, lines) {
    const body = (Array.isArray(lines) ? lines : [lines]).join('\n');
    console.log(
      boxen(body, {
        title: accent.bold(title),
        titleAlignment: 'left',
        padding: 1,
        margin: { top: 1, bottom: 0, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'gray',
      }),
    );
  },

  // status pill, e.g. badge('ok','Online') -> green "Online"
  badge(kind, text) {
    const f = { ok: good, bad: bad, warn: warnC, info: chalk.cyan, dim: dimC }[kind] || chalk.white;
    return f(text);
  },
};

// Non-animated stand-in for ora with the same interface we use.
class PlainSpinner {
  constructor(text) {
    this.text = text;
  }
  start() {
    console.log(accent('•') + ' ' + this.text);
    return this;
  }
  stop() {
    return this;
  }
  succeed(msg) {
    console.log(good('✓') + ' ' + (msg ?? this.text));
    return this;
  }
  fail(msg) {
    console.log(bad('✗') + ' ' + (msg ?? this.text));
    return this;
  }
}
