// Universal Scientific, Symbolic & Physical Math Engine
// Provides high-precision calculation, scientific functions, physical constants,
// symbolic linear/polynomial algebra, and science problem detection.

export const CONSTANTS = {
  pi: Math.PI,
  PI: Math.PI,
  π: Math.PI,
  e: Math.E,
  E: Math.E,
  c: 299792458, // Speed of light in vacuum (m/s)
  g: 9.80665,   // Standard acceleration due to gravity (m/s^2)
  G: 6.67430e-11, // Universal gravitational constant (N m^2/kg^2)
  h: 6.62607015e-34, // Planck constant (J s)
  hbar: 1.054571817e-34, // Reduced Planck constant (J s)
  kB: 1.380649e-23, // Boltzmann constant (J/K)
  k: 1.380649e-23,
  R: 8.314462618, // Molar gas constant (J/(mol K))
  Na: 6.02214076e23, // Avogadro constant (1/mol)
  N_A: 6.02214076e23,
  NA: 6.02214076e23,
  qe: 1.602176634e-19, // Elementary charge (C)
  e_charge: 1.602176634e-19,
  me: 9.1093837e-31, // Electron rest mass (kg)
  mp: 1.67262192e-27, // Proton rest mass (kg)
  mn: 1.67492749e-27, // Neutron rest mass (kg)
  eps0: 8.8541878128e-12, // Vacuum electric permittivity (F/m)
  mu0: 1.25663706212e-6, // Vacuum magnetic permeability (N/A^2)
  sigma: 5.670374419e-8, // Stefan-Boltzmann constant (W/(m^2 K^4))
  amu: 1.6605390666e-27, // Atomic mass unit (kg)
  u: 1.6605390666e-27,
  atm: 101325, // Standard atmospheric pressure (Pa)
  eV: 1.602176634e-19 // Electronvolt in Joules (J)
};

export function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  if (n > 170) return Infinity;
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

export const MATH_FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt,
  log: Math.log10, log10: Math.log10, ln: Math.log, log2: Math.log2,
  exp: Math.exp, abs: Math.abs,
  round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max, pow: Math.pow,
  fact: factorial,
  rad: deg => deg * (Math.PI / 180),
  deg: rad => rad * (180 / Math.PI),
  sind: deg => Math.sin(deg * (Math.PI / 180)),
  cosd: deg => Math.cos(deg * (Math.PI / 180)),
  tand: deg => Math.tan(deg * (Math.PI / 180))
};

export function formatNumber(n) {
  if (typeof n !== 'number' || isNaN(n)) return 'NaN';
  if (!isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  const abs = Math.abs(n);
  if (abs >= 1e12 || (abs < 1e-5 && abs > 0)) {
    return n.toExponential(6);
  }
  const str = n.toFixed(8);
  return parseFloat(str).toString();
}

export function evaluateNumericAndScientific(raw) {
  let expr = String(raw || '').trim();
  if (!expr) return null;

  // Unicode math symbol replacements
  expr = expr.replace(/×/g, '*')
             .replace(/÷/g, '/')
             .replace(/−/g, '-')
             .replace(/π/g, 'pi')
             .replace(/√\s*(\d+|\([^\)]+\))/g, (m, p1) => `sqrt(${p1})`);

  // Degrees: e.g. sin(90 deg) or sin(90°) => sind(90)
  expr = expr.replace(/sin\s*\(\s*([^)]+?)\s*(?:deg|°)\s*\)/gi, 'sind($1)')
             .replace(/cos\s*\(\s*([^)]+?)\s*(?:deg|°)\s*\)/gi, 'cosd($1)')
             .replace(/tan\s*\(\s*([^)]+?)\s*(?:deg|°)\s*\)/gi, 'tand($1)');

  // Factorial: 5! => fact(5)
  expr = expr.replace(/(\d+)!/g, (m, p1) => `fact(${p1})`);

  // Power: ^ => **
  expr = expr.replace(/\^/g, '**');

  // Percentage: 20% * 50 => (20/100) * 50
  expr = expr.replace(/(\d+(?:\.\d+)?)%/g, (m, p1) => `(${p1}/100)`);

  // 'x' as multiplication between numbers or parentheses (e.g. 5 x 5, 5x(2+2), (3)x4)
  expr = expr.replace(/(\d)\s*[xX]\s*(\d)/g, '$1*$2');
  expr = expr.replace(/(\))\s*[xX]\s*(\d)/g, '$1*$2');
  expr = expr.replace(/(\d)\s*[xX]\s*(\()/g, '$1*$2');
  expr = expr.replace(/(\))\s*[xX]\s*(\()/g, '$1*$2');

  // Implicit multiplication: 2(3) => 2*(3), (2)(3) => (2)*(3)
  expr = expr.replace(/(\d)\s*\(/g, '$1*(');
  expr = expr.replace(/\)\s*\(/g, ')*(');

  // Implicit multiplication with constants: 2pi => 2*pi, 3c => 3*c
  const constNames = Object.keys(CONSTANTS).join('|');
  const constRegex = new RegExp(`(\\d)\\s*(${constNames})\\b`, 'g');
  expr = expr.replace(constRegex, '$1*$2');

  // Whitelist safe tokens: digits, operators, parens, commas, whitespace, and known names
  const allowedNames = new Set([...Object.keys(CONSTANTS), ...Object.keys(MATH_FUNCS)]);
  const tokens = expr.match(/[a-zA-Z_]\w*/g) || [];
  for (const token of tokens) {
    if (!allowedNames.has(token)) {
      return null; // Unknown identifier -> pass to algebra or AI solver
    }
  }

  try {
    const context = { ...CONSTANTS, ...MATH_FUNCS };
    const keys = Object.keys(context);
    const vals = Object.values(context);
    const fn = new Function(...keys, `"use strict"; return (${expr});`);
    const val = fn(...vals);
    if (typeof val === 'number' && !isNaN(val)) {
      return val;
    }
  } catch {}
  return null;
}

export function simplifySymbolicAlgebra(raw) {
  let expr = String(raw || '').trim();
  if (!expr) return null;

  expr = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');

  // Linear equation solver: e.g. 2x + 4 = 10, x - 5 = 15, 3x = 12
  if (expr.includes('=')) {
    const parts = expr.split('=');
    if (parts.length === 2) {
      const left = parts[0].trim();
      const right = parts[1].trim();
      const m = left.match(/^([+-]?\d*(?:\.\d+)?)\s*([a-zA-Z])\s*([+-]\s*\d+(?:\.\d+)?)?$/);
      const c = Number(right);
      if (m && !isNaN(c)) {
        let aStr = m[1];
        let varName = m[2];
        let a = aStr === '' || aStr === '+' ? 1 : aStr === '-' ? -1 : Number(aStr);
        let b = m[3] ? Number(m[3].replace(/\s+/g, '')) : 0;
        if (a !== 0) {
          const val = (c - b) / a;
          const rounded = Number.isInteger(val) ? val : Number(val.toFixed(6));
          return `${varName} = ${rounded}`;
        }
      }
    }
  }

  // Multiplication: x * x => x², 2x * 3x => 6x², 5 * x => 5x
  const mulMatch = expr.match(/^([+-]?\d*(?:\.\d+)?)\s*([a-zA-Z])\s*[*x×]\s*([+-]?\d*(?:\.\d+)?)\s*([a-zA-Z])$/);
  if (mulMatch) {
    let a = mulMatch[1] === '' ? 1 : mulMatch[1] === '-' ? -1 : Number(mulMatch[1]);
    let v1 = mulMatch[2];
    let b = mulMatch[3] === '' ? 1 : mulMatch[3] === '-' ? -1 : Number(mulMatch[3]);
    let v2 = mulMatch[4];
    let coeff = a * b;
    let coeffStr = coeff === 1 ? '' : coeff === -1 ? '-' : String(coeff);
    if (v1 === v2) {
      return `${coeffStr}${v1}²`;
    } else {
      return `${coeffStr}${v1}${v2}`;
    }
  }

  // Linear terms combiner: e.g. x + x, 2x + 3x - x + 5, a + a + b
  const termRegex = /([+-]?\s*\d*(?:\.\d+)?\s*[a-zA-Z]|[+-]?\s*\d+(?:\.\d+)?)/g;
  const terms = expr.match(termRegex);
  if (terms && terms.join('').replace(/\s+/g, '') === expr.replace(/\s+/g, '')) {
    const varCoeffs = {};
    let constant = 0;
    let hasVar = false;
    
    for (let term of terms) {
      term = term.replace(/\s+/g, '');
      const varM = term.match(/^([+-]?\d*(?:\.\d+)?)([a-zA-Z])$/);
      if (varM) {
        hasVar = true;
        let cStr = varM[1];
        let v = varM[2];
        let c = cStr === '' || cStr === '+' ? 1 : cStr === '-' ? -1 : Number(cStr);
        varCoeffs[v] = (varCoeffs[v] || 0) + c;
      } else {
        constant += Number(term);
      }
    }
    
    if (hasVar) {
      const resultParts = [];
      for (const [v, c] of Object.entries(varCoeffs)) {
        if (c === 0) continue;
        let sign = resultParts.length > 0 ? (c > 0 ? '+ ' : '- ') : (c < 0 ? '-' : '');
        let absC = Math.abs(c);
        let coeffStr = absC === 1 ? '' : String(absC);
        resultParts.push(`${sign}${coeffStr}${v}`);
      }
      if (constant !== 0 || resultParts.length === 0) {
        let sign = resultParts.length > 0 ? (constant > 0 ? '+ ' : '- ') : (constant < 0 ? '-' : '');
        resultParts.push(`${sign}${Math.abs(constant)}`);
      }
      return resultParts.join(' ');
    }
  }

  return null;
}

export function isScienceOrWordProblem(raw) {
  const q = String(raw || '').toLowerCase();
  const keywords = [
    'energy', 'velocity', 'acceleration', 'force', 'gravity', 'mass',
    'momentum', 'frequency', 'wavelength', 'power', 'pressure', 'density',
    'kinetic', 'potential', 'ohm', 'volt', 'ampere', 'coulomb', 'joule', 'watt',
    'molar', 'mole', 'moles', 'ph', 'acid', 'base', 'reaction', 'half life',
    'h2so4', 'h2o', 'nacl', 'co2', 'o2', 'chemistry', 'physics', 'speed of light',
    'derivative', 'integral', 'matrix', 'limit', 'equation', 'solve for', 'how many'
  ];
  return keywords.some(k => q.includes(k));
}
