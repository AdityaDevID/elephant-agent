'use strict';

const A = require('./ansi');

// Huruf "ELEPHANT" gaya figlet "small", dirangkai per baris.
const L = {
  E: [' ___ ', '| __|', '| _| ', '|___|'],
  L: [' _    ', '| |   ', '| |__ ', '|____|'],
  P: [' ___ ', '| _ \\', '|  _/', '|_|  '],
  H: [' _  _ ', '| || |', '| __ |', '|_||_|'],
  A: ['   _   ', '  /_\\  ', ' / _ \\ ', '/_/ \\_\\'],
  N: [' _  _ ', '| \\| |', '| .` |', '|_|\\_|'],
  T: [' _____ ', '|_   _|', '  | |  ', '  |_|  '],
};

const WORD = ['E', 'L', 'E', 'P', 'H', 'A', 'N', 'T'];
const GRADIENT = [208, 209, 215, 221];

const ELEPHANT = [
  '     __      __     ',
  '   .\'  \'.__.\'  \'.   ',
  '  /  .--.  .--.  \\  ',
  ' |  (    )(    )  | ',
  '  \\  \'--\'oo\'--\'  /  ',
  '   \'.    ||    .\'   ',
  '     \'-._||_.-\'     ',
  '         ||         ',
  '         ||         ',
  '         \'\'         ',
];

function banner() {
  const rows = [];
  for (let r = 0; r < 4; r++) {
    const line = WORD.map((ch) => L[ch][r]).join('');
    rows.push(A.bold(A.fg(GRADIENT[r])(line)));
  }
  return rows;
}

function elephant() {
  return ELEPHANT.map((l) => A.fg(250)(l));
}

module.exports = { banner, elephant, ELEPHANT };
