import fastify from "fastify";
import cors from "@fastify/cors";
import fetch from "node-fetch";

// ==================== CẤU HÌNH ====================
const PORT = 3000;
const VALID_KEY = "Hentaiz";
const ADMIN_ID = "@cskhgiabao";

const API_URL_HU  = "https://wtx.tele68.com/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=83991213bfd4c554dc94bcd98979bdc5";
const API_URL_MD5 = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const normalizeResult = (score) => score >= 11 ? 'TAI' : 'XIU';

/* ================================================================
 *  HELPERS CƠ BẢN
 * ================================================================ */
function blocksOf(pat) {
  const b = []; let c = 1;
  for (let i = 1; i < pat.length; i++) {
    if (pat[i] === pat[i - 1]) c++;
    else { b.push(c); c = 1; }
  }
  b.push(c);
  return b;
}
const isPalindrome = s => s === s.split('').reverse().join('');

function namePattern(pat) {
  if (!pat) return 'RỖNG';
  const b = blocksOf(pat);
  const L = pat.length;
  const tag = b.join('-');
  if (b.length === 1) return `BỆT-${L}`;
  if (isPalindrome(pat) && L >= 4) return `ĐX-${L}`;
  for (const k of [2, 3, 4, 5]) {
    if (L >= k * 2 && L % k === 0) {
      const unit = pat.slice(0, k);
      if (pat === unit.repeat(L / k)) return `CHUKỲ-${L}(k=${k})`;
    }
  }
  if (/^(BT)+B?$/.test(pat) || /^(TB)+T?$/.test(pat)) return `SOLE-${L}`;
  if (/^(BBTT)+B{0,2}$/.test(pat) || /^(TTBB)+T{0,2}$/.test(pat)) return `GẤPĐÔI-${L}`;
  const fibo = [1, 1, 2, 3, 5, 8, 13];
  if (b.length >= 3 && b.every((v, i) => v === fibo[i])) return `FIBO-${L}`;
  if (b.length >= 3) {
    const tang = b.every((v, i) => i === 0 || v === b[i - 1] + 1);
    const giam = b.every((v, i) => i === 0 || v === b[i - 1] - 1);
    if (tang) return `THANG↑-${L}`;
    if (giam) return `THANG↓-${L}`;
  }
  if (b.length === 3 && b[0] === b[2]) return `KẸP-${tag}`;
  if (b.length === 3 && b[0] < b[1] && b[1] < b[2]) return `TAMGIÁC↑-${tag}`;
  if (b.length === 3 && b[0] > b[1] && b[1] > b[2]) return `TAMGIÁC↓-${tag}`;
  return `NHỊP-${tag}`;
}

function currentStreak(seq) {
  if (seq.length === 0) return 0;
  let s = 1;
  const last = seq[seq.length - 1];
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) s++;
    else break;
  }
  return s;
}

/* ================================================================
 *  REGIME DETECTION
 * ================================================================ */
function detectRegime(sessions) {
  const recent = sessions.slice(-50);
  if (recent.length < 30) return 'unknown';

  const seq = recent.map(s => s.result);

  let maxStreak = 1, cur = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) cur++;
    else { maxStreak = Math.max(maxStreak, cur); cur = 1; }
  }
  maxStreak = Math.max(maxStreak, cur);

  const taiRatio = seq.filter(s => s === 'TAI').length / seq.length;
  const bias = Math.abs(taiRatio - 0.5);

  let alt = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i - 1]) alt++;
  }
  const altRate = alt / (seq.length - 1);

  if (maxStreak >= 6) return 'streaky';
  if (altRate > 0.62) return 'choppy';
  if (bias > 0.12) return 'trending';
  return 'balanced';
}

/* ================================================================
 *  SCORE HELPERS
 * ================================================================ */
const scoreBucket = (s) => s <= 7 ? 'L' : s <= 10 ? 'M' : s <= 13 ? 'H' : 'X';

function buildScoreLookup(history, score) {
  let tai = 0, xiu = 0;
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].score === score) {
      if (history[i + 1].result === 'TAI') tai++;
      else xiu++;
    }
  }
  const total = tai + xiu;
  const pTai = (tai + 2) / (total + 4);
  return { tai, xiu, total, pTai };
}

function buildScoreRangeLookup(history, lo, hi) {
  let tai = 0, xiu = 0;
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].score >= lo && history[i].score <= hi) {
      if (history[i + 1].result === 'TAI') tai++;
      else xiu++;
    }
  }
  const total = tai + xiu;
  const pTai = (tai + 2) / (total + 4);
  return { tai, xiu, total, pTai };
}

/* ================================================================
 *  NHÓM SIGNAL TƯƠNG QUAN
 * ================================================================ */
const SIGNAL_GROUPS = {
  markov:      ['markov2', 'markov3', 'markov4', 'recentMarkov'],
  streak:      ['streak', 'betBreaker', 'streakScoreCombo'],
  score:       ['scoreRegression', 'scoreNeighborhood', 'scoreTransition', 'scoreAutoCorr'],
  scoreLookup: ['exactScoreLookup', 'scoreRangeLookup', 'scorePairPattern', 'extremeScoreBias'],
  pattern:     ['patternMatch', 'alternating', 'doubleBlock', 'longPattern'],
  momentum:    ['momentum'],
  dice:        ['diceComboMemory'],
  timeframe:   ['dualTimeframe'],
};
function getGroupOf(name) {
  for (const [g, arr] of Object.entries(SIGNAL_GROUPS)) {
    if (arr.includes(name)) return g;
  }
  return 'other';
}

/* ================================================================
 *  ANTI-SKEW TRACKER
 * ================================================================ */
function calcSkew(log, limit = 20) {
  const recent = log
    .filter(p => p.actual !== null && p.predict !== 'NGHI')
    .slice(-limit);
  if (recent.length < 8) return { skew: 0, leanSide: null, tai: 0, xiu: 0, total: 0 };
  let tai = 0, xiu = 0;
  for (const p of recent) {
    if (p.predict === 'TAI') tai++;
    else xiu++;
  }
  const total = tai + xiu;
  const skew = Math.abs(tai - xiu) / total;
  const leanSide = tai > xiu ? 'TAI' : (xiu > tai ? 'XIU' : null);
  return { skew, leanSide, tai, xiu, total };
}

/* ================================================================
 *  22 SIGNALS
 * ================================================================ */
const SIGNALS_V7 = {

  markov2: (history) => {
    if (history.length < 30) return null;
    const seq = history.map(s => s.result);
    const key = seq.slice(-2).join('|');
    let tai = 0, xiu = 0;
    for (let i = 2; i < seq.length; i++) {
      if (seq.slice(i - 2, i).join('|') === key) {
        if (seq[i] === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 12) return null;
    const pTai = (tai + 2) / (total + 4);
    if (pTai > 0.56) return 'TAI';
    if (pTai < 0.44) return 'XIU';
    return null;
  },

  markov3: (history) => {
    if (history.length < 40) return null;
    const seq = history.map(s => s.result);
    const key = seq.slice(-3).join('|');
    let tai = 0, xiu = 0;
    for (let i = 3; i < seq.length; i++) {
      if (seq.slice(i - 3, i).join('|') === key) {
        if (seq[i] === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 8) return null;
    const pTai = (tai + 2) / (total + 4);
    if (pTai > 0.58) return 'TAI';
    if (pTai < 0.42) return 'XIU';
    return null;
  },

  markov4: (history) => {
    if (history.length < 120) return null;
    const seq = history.map(s => s.result);
    const key = seq.slice(-4).join('|');
    let tai = 0, xiu = 0;
    for (let i = 4; i < seq.length; i++) {
      if (seq.slice(i - 4, i).join('|') === key) {
        if (seq[i] === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 6) return null;
    const pTai = (tai + 2) / (total + 4);
    if (pTai > 0.64) return 'TAI';
    if (pTai < 0.36) return 'XIU';
    return null;
  },

  recentMarkov: (history) => {
    if (history.length < 100) return null;
    const recent = history.slice(-150);
    const seq = recent.map(s => s.result);
    if (seq.length < 50) return null;
    const key = seq.slice(-2).join('|');
    let tai = 0, xiu = 0;
    for (let i = 2; i < seq.length; i++) {
      if (seq.slice(i - 2, i).join('|') === key) {
        if (seq[i] === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 8) return null;
    const pTai = (tai + 2) / (total + 4);
    if (pTai > 0.6) return 'TAI';
    if (pTai < 0.4) return 'XIU';
    return null;
  },

  streak: (history) => {
    if (history.length < 60) return null;
    const seq = history.map(s => s.result);
    const last = seq[seq.length - 1];
    let current = 1;
    for (let i = seq.length - 2; i >= 0; i--) {
      if (seq[i] === last) current++;
      else break;
    }
    if (current < 3) return null;

    let cont = 0, brk = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      let s = 1;
      for (let j = i - 1; j >= 0; j--) {
        if (seq[j] === seq[i]) s++;
        else break;
      }
      if (s === current) {
        if (seq[i + 1] === seq[i]) cont++;
        else brk++;
      }
    }
    const total = cont + brk;
    if (total < 6) return null;
    const pCont = (cont + 1.5) / (total + 3);
    if (pCont > 0.58) return last;
    if (pCont < 0.42) return last === 'TAI' ? 'XIU' : 'TAI';
    return null;
  },

  betBreaker: (history) => {
    if (history.length < 100) return null;
    const seq = history.map(s => s.result);
    const last = seq[seq.length - 1];
    let current = 1;
    for (let i = seq.length - 2; i >= 0; i--) {
      if (seq[i] === last) current++;
      else break;
    }
    if (current < 4 || current > 9) return null;

    let cont = 0, brk = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      let s = 1;
      for (let j = i - 1; j >= 0; j--) {
        if (seq[j] === seq[i]) s++;
        else break;
      }
      if (s === current) {
        if (seq[i + 1] === seq[i]) cont++;
        else brk++;
      }
    }
    const total = cont + brk;
    if (total < 5) return null;
    const pBrk = (brk + 1.5) / (total + 3);
    if (pBrk > 0.6) return last === 'TAI' ? 'XIU' : 'TAI';
    if (pBrk < 0.4) return last;
    return null;
  },

  streakScoreCombo: (history) => {
    if (history.length < 60) return null;
    const seq = history.map(h => h.result);
    const last = seq[seq.length - 1];
    let streak = 1;
    for (let i = seq.length - 2; i >= 0; i--) {
      if (seq[i] === last) streak++;
      else break;
    }
    if (streak < 2 || streak > 5) return null;

    const recentScores = history.slice(-streak).map(h => h.score);
    const avgScore = recentScores.reduce((a, b) => a + b, 0) / streak;

    if (last === 'TAI' && avgScore <= 12) return 'XIU';
    if (last === 'XIU' && avgScore >= 10) return 'TAI';
    return null;
  },

  scoreRegression: (history) => {
    if (history.length < 60) return null;
    const score = history[history.length - 1].score;
    if (score >= 5 && score <= 15) return null;

    let tai = 0, xiu = 0;
    for (let i = 0; i < history.length - 1; i++) {
      if (history[i].score === score) {
        if (history[i + 1].result === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 5) return null;
    const pTai = (tai + 1.5) / (total + 3);
    if (pTai > 0.6) return 'TAI';
    if (pTai < 0.4) return 'XIU';
    return null;
  },

  scoreNeighborhood: (history) => {
    if (history.length < 80) return null;
    const lastScore = history[history.length - 1].score;
    let tai = 0, xiu = 0;
    for (let i = 0; i < history.length - 1; i++) {
      if (Math.abs(history[i].score - lastScore) <= 1) {
        if (history[i + 1].result === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 25) return null;
    const pTai = (tai + 3) / (total + 6);
    if (pTai > 0.58) return 'TAI';
    if (pTai < 0.42) return 'XIU';
    return null;
  },

  scoreTransition: (history) => {
    if (history.length < 100) return null;
    const lastBucket = scoreBucket(history[history.length - 1].score);
    let tai = 0, xiu = 0;
    for (let i = 0; i < history.length - 1; i++) {
      if (scoreBucket(history[i].score) === lastBucket) {
        if (history[i + 1].result === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 30) return null;
    const pTai = (tai + 3) / (total + 6);
    if (pTai > 0.58) return 'TAI';
    if (pTai < 0.42) return 'XIU';
    return null;
  },

  scoreAutoCorr: (history) => {
    if (history.length < 80) return null;
    const last = history[history.length - 1].score;
    if (last < 13 && last > 8) return null;

    let tai = 0, xiu = 0;
    for (let i = 0; i < history.length - 1; i++) {
      if (last >= 13 && history[i].score >= 13) {
        if (history[i + 1].result === 'TAI') tai++;
        else xiu++;
      } else if (last <= 8 && history[i].score <= 8) {
        if (history[i + 1].result === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 20) return null;
    const pTai = (tai + 2.5) / (total + 5);
    if (pTai > 0.58) return 'TAI';
    if (pTai < 0.42) return 'XIU';
    return null;
  },

  exactScoreLookup: (history) => {
    if (history.length < 100) return null;
    const lastScore = history[history.length - 1].score;
    const { total, pTai } = buildScoreLookup(history, lastScore);

    if (total < 8) return null;

    const threshold = total < 15 ? 0.68
                    : total < 30 ? 0.62
                    : total < 60 ? 0.58
                    : 0.55;

    if (pTai > threshold) return 'TAI';
    if (pTai < 1 - threshold) return 'XIU';
    return null;
  },

  scoreRangeLookup: (history) => {
    if (history.length < 120) return null;
    const lastScore = history[history.length - 1].score;

    let lo, hi, minSamples;
    if (lastScore <= 6)        { lo = 3;  hi = 6;  minSamples = 25; }
    else if (lastScore <= 8)   { lo = 7;  hi = 8;  minSamples = 40; }
    else if (lastScore <= 10)  { lo = 9;  hi = 10; minSamples = 50; }
    else if (lastScore <= 12)  { lo = 11; hi = 12; minSamples = 60; }
    else if (lastScore <= 14)  { lo = 13; hi = 14; minSamples = 40; }
    else                       { lo = 15; hi = 18; minSamples = 25; }

    const { total, pTai } = buildScoreRangeLookup(history, lo, hi);
    if (total < minSamples) return null;

    if (pTai > 0.57) return 'TAI';
    if (pTai < 0.43) return 'XIU';
    return null;
  },

  scorePairPattern: (history) => {
    if (history.length < 150) return null;
    const last = history[history.length - 1].score;
    const prev = history[history.length - 2].score;

    let tai = 0, xiu = 0;
    for (let i = 1; i < history.length - 1; i++) {
      if (history[i].score === last && history[i - 1].score === prev) {
        if (history[i + 1].result === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 5) return null;
    const pTai = (tai + 1.5) / (total + 3);
    if (pTai > 0.66) return 'TAI';
    if (pTai < 0.34) return 'XIU';
    return null;
  },

  extremeScoreBias: (history) => {
    if (history.length < 80) return null;
    const last = history[history.length - 1].score;

    let tai = 0, xiu = 0;
    if (last <= 5) {
      for (let i = 0; i < history.length - 1; i++) {
        if (history[i].score <= 5) {
          if (history[i + 1].result === 'TAI') tai++;
          else xiu++;
        }
      }
    } else if (last >= 16) {
      for (let i = 0; i < history.length - 1; i++) {
        if (history[i].score >= 16) {
          if (history[i + 1].result === 'TAI') tai++;
          else xiu++;
        }
      }
    } else {
      return null;
    }

    const total = tai + xiu;
    if (total < 8) return null;
    const pTai = (tai + 2) / (total + 4);
    if (pTai > 0.62) return 'TAI';
    if (pTai < 0.38) return 'XIU';
    return null;
  },

  patternMatch: (history) => {
    if (history.length < 80) return null;
    const seq = history.map(s => s.result);
    for (let plen = 6; plen >= 4; plen--) {
      if (seq.length < plen + 10) continue;
      const pattern = seq.slice(-plen).join('|');
      let tai = 0, xiu = 0;
      for (let i = plen; i < seq.length; i++) {
        if (seq.slice(i - plen, i).join('|') === pattern) {
          if (seq[i] === 'TAI') tai++;
          else xiu++;
        }
      }
      const total = tai + xiu;
      if (total < 5) continue;
      const pTai = (tai + 1.5) / (total + 3);
      if (pTai > 0.62) return 'TAI';
      if (pTai < 0.38) return 'XIU';
    }
    return null;
  },

  alternating: (history) => {
    if (history.length < 30) return null;
    const seq = history.map(s => s.result);
    const last4 = seq.slice(-4);
    if (last4.length < 4) return null;
    const isAlt = last4[0] !== last4[1] && last4[1] !== last4[2] && last4[2] !== last4[3];
    if (!isAlt) return null;

    let cont = 0, brk = 0;
    for (let i = 4; i < seq.length; i++) {
      const p = seq.slice(i - 4, i);
      if (p[0] !== p[1] && p[1] !== p[2] && p[2] !== p[3]) {
        const expected = p[3] === 'TAI' ? 'XIU' : 'TAI';
        if (seq[i] === expected) cont++;
        else brk++;
      }
    }
    const total = cont + brk;
    if (total < 8) return null;
    const pCont = (cont + 1.5) / (total + 3);
    const expected = last4[3] === 'TAI' ? 'XIU' : 'TAI';
    if (pCont > 0.56) return expected;
    if (pCont < 0.44) return last4[3];
    return null;
  },

  doubleBlock: (history) => {
    if (history.length < 60) return null;
    const seq = history.map(s => s.result);
    const last6 = seq.slice(-6);
    if (last6.length < 6) return null;
    const b1 = last6[0] === last6[1];
    const b2 = last6[2] === last6[3];
    const b3 = last6[4] === last6[5];
    const diff12 = last6[0] !== last6[2];
    const diff23 = last6[2] !== last6[4];
    if (!(b1 && b2 && b3 && diff12 && diff23)) return null;

    let tai = 0, xiu = 0;
    for (let i = 6; i < seq.length; i++) {
      const p = seq.slice(i - 6, i);
      if (p[0] === p[1] && p[2] === p[3] && p[4] === p[5]
          && p[0] !== p[2] && p[2] !== p[4]) {
        if (seq[i] === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 5) return null;
    const pTai = (tai + 1.5) / (total + 3);
    if (pTai > 0.6) return 'TAI';
    if (pTai < 0.4) return 'XIU';
    return null;
  },

  longPattern: (history) => {
    if (history.length < 150) return null;
    const seq = history.map(s => s.result);
    for (let plen = 8; plen >= 7; plen--) {
      if (seq.length < plen + 20) continue;
      const pattern = seq.slice(-plen).join('|');
      let tai = 0, xiu = 0;
      for (let i = plen; i < seq.length; i++) {
        if (seq.slice(i - plen, i).join('|') === pattern) {
          if (seq[i] === 'TAI') tai++;
          else xiu++;
        }
      }
      const total = tai + xiu;
      if (total < 4) continue;
      const pTai = (tai + 1.5) / (total + 3);
      if (pTai > 0.67) return 'TAI';
      if (pTai < 0.33) return 'XIU';
    }
    return null;
  },

  momentum: (history) => {
    if (history.length < 30) return null;
    const recent = history.slice(-12);
    const tai = recent.filter(s => s.result === 'TAI').length;
    const ratio = tai / recent.length;
    if (ratio >= 0.75) return 'XIU';
    if (ratio <= 0.25) return 'TAI';
    return null;
  },

  diceComboMemory: (history) => {
    if (history.length < 100) return null;
    const last = history[history.length - 1];
    const key = last.dice.slice().sort((a, b) => a - b).join(',');

    let tai = 0, xiu = 0;
    for (let i = 0; i < history.length - 1; i++) {
      const k = history[i].dice.slice().sort((a, b) => a - b).join(',');
      if (k === key) {
        if (history[i + 1].result === 'TAI') tai++;
        else xiu++;
      }
    }
    const total = tai + xiu;
    if (total < 3) return null;
    const pTai = (tai + 1.5) / (total + 3);
    if (pTai > 0.65) return 'TAI';
    if (pTai < 0.35) return 'XIU';
    return null;
  },

  dualTimeframe: (history) => {
    if (history.length < 80) return null;
    const short = history.slice(-15);
    const long = history.slice(-80);

    const sTai = short.filter(h => h.result === 'TAI').length / short.length;
    const lTai = long.filter(h => h.result === 'TAI').length / long.length;

    if (sTai >= 0.60 && lTai >= 0.56) return 'XIU';
    if (sTai <= 0.40 && lTai <= 0.44) return 'TAI';
    return null;
  },
};

/* ================================================================
 *  BACKTEST ENGINE V2 (3-fold + recency + stability)
 * ================================================================ */
function backtestSignal(sigFn, sessions, minHistory = 50) {
  if (sessions.length < minHistory + 20) {
    return { acc: null, weightedAcc: null, total: 0, stability: 0, folds: 0 };
  }

  const folds = 3;
  const start = Math.max(minHistory, Math.floor(sessions.length * 0.35));
  const testSize = Math.max(1, Math.floor((sessions.length - start) / folds));

  const foldResults = [];
  for (let f = 0; f < folds; f++) {
    let correct = 0, total = 0;
    const fStart = start + f * testSize;
    const fEnd = Math.min(fStart + testSize, sessions.length - 1);
    for (let i = fStart; i < fEnd; i++) {
      const hist = sessions.slice(0, i + 1);
      const pred = sigFn(hist);
      if (pred === null || pred === 'NGHI') continue;
      total++;
      if (pred === sessions[i + 1].result) correct++;
    }
    if (total >= 5) {
      foldResults.push({ acc: correct / total, total, correct });
    }
  }

  if (foldResults.length === 0) {
    return { acc: null, weightedAcc: null, total: 0, stability: 0, folds: 0 };
  }

  let totalCorrect = 0, totalSamples = 0;
  let weightedAcc = 0, totalWeight = 0;
  for (let i = 0; i < foldResults.length; i++) {
    const w = 1 + i * 0.6;
    weightedAcc += foldResults[i].acc * w;
    totalWeight += w;
    totalCorrect += foldResults[i].correct;
    totalSamples += foldResults[i].total;
  }

  const acc = totalSamples > 0 ? totalCorrect / totalSamples : null;
  const wAcc = totalWeight > 0 ? weightedAcc / totalWeight : null;

  const accs = foldResults.map(f => f.acc);
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const variance = accs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / accs.length;
  const stability = Math.max(0, 1 - Math.sqrt(variance) * 3);

  return {
    acc,
    weightedAcc: wAcc,
    total: totalSamples,
    stability,
    folds: foldResults.length
  };
}

/* ================================================================
 *  FALLBACK THÔNG MINH (có anti-skew)
 * ================================================================ */
function getFallbackPredict(sessions, reason, log = null) {
  const recent = sessions.slice(-30);
  let pred = null;

  if (recent.length >= 15) {
    const taiCount = recent.filter(s => s.result === 'TAI').length;
    const ratio = taiCount / recent.length;
    if (ratio > 0.60) pred = 'XIU';
    else if (ratio < 0.40) pred = 'TAI';
  }

  if (!pred) {
    const lastId = sessions.at(-1)?.session ?? 0;
    const base = lastId % 2 === 0 ? 'TAI' : 'XIU';

    if (log && log.length > 0) {
      const { skew, leanSide } = calcSkew(log, 15);
      if (skew > 0.55 && leanSide === base) {
        pred = base === 'TAI' ? 'XIU' : 'TAI';
        return {
          predict: pred,
          confidence: 52,
          reason: `⚪ ${reason} | Anti-skew đảo ${pred === 'TAI' ? 'TÀI' : 'XỈU'}`,
          signals: []
        };
      }
    }
    pred = base;
  }

  return {
    predict: pred,
    confidence: 52,
    reason: `⚪ ${reason} | Fallback ${pred === 'TAI' ? 'TÀI' : 'XỈU'}`,
    signals: []
  };
}

/* ================================================================
 *  MAIN PREDICT — v8.1
 * ================================================================ */
function predict(sessions, log = null, opts = {}) {
  if (sessions.length < 8) {
    return getFallbackPredict(sessions, 'Chưa đủ mẫu', log);
  }

  const seq = sessions.map(s => s.result === 'TAI' ? 'B' : 'T');
  const streak = currentStreak(seq);

  if (streak >= 12) {
    return {
      predict: 'NGHI',
      confidence: 0,
      reason: `⚠️ Bệt ${streak} phiên (cực hiếm) → NGHỈ chờ cầu mới`,
      signals: []
    };
  }

  if (sessions.length < 60) {
    return getFallbackPredict(sessions, `Cần thêm dữ liệu (${sessions.length}/60)`, log);
  }

  const regime = detectRegime(sessions);

  const backtests = {};
  for (const [name, fn] of Object.entries(SIGNALS_V7)) {
    backtests[name] = backtestSignal(fn, sessions);
  }

  const rawVotes = [];
  for (const [name, fn] of Object.entries(SIGNALS_V7)) {
    const bt = backtests[name];
    if (!bt.acc || bt.total < 15 || bt.acc < 0.52) continue;
    if (bt.stability < 0.25) continue;
    const wAcc = bt.weightedAcc ?? bt.acc;
    if (wAcc < 0.52) continue;

    const pred = fn(sessions);
    if (pred === null) continue;

    const edgeAll    = bt.acc - 0.5;
    const edgeRecent = wAcc - 0.5;
    const combinedEdge = edgeAll * 0.4 + edgeRecent * 0.6;

    const sampleScale = Math.min(1, bt.total / 40);
    const stabilityFactor = 0.5 + bt.stability * 0.5;
    const weight = combinedEdge * 2 * sampleScale * stabilityFactor;

    rawVotes.push({
      name, group: getGroupOf(name),
      predict: pred,
      accuracy: bt.acc,
      weightedAcc: wAcc,
      samples: bt.total,
      stability: bt.stability,
      weight
    });
  }

  const groupBest = new Map();
  for (const v of rawVotes) {
    const cur = groupBest.get(v.group);
    if (!cur || v.weight > cur.weight) groupBest.set(v.group, v);
  }
  const votes = [...groupBest.values()];

  if (votes.length === 0) {
    return getFallbackPredict(sessions, 'Không có signal đủ mạnh', log);
  }

  let vTai = 0, vXiu = 0;
  for (const v of votes) {
    if (v.predict === 'TAI') vTai += v.weight;
    else vXiu += v.weight;
  }

  if (Math.abs(vTai - vXiu) < 0.02) {
    return getFallbackPredict(sessions, 'Ensemble hòa phiếu', log);
  }

  const pred = vTai > vXiu ? 'TAI' : 'XIU';
  const winWeight = Math.max(vTai, vXiu);
  const totalWeight = vTai + vXiu;
  const edge = winWeight / totalWeight;

  const agreeing = votes.filter(v => v.predict === pred);
  const agreement = agreeing.length / votes.length;
  const nGroups = agreeing.length;

  const capByGroups = nGroups >= 4 ? 68
                    : nGroups === 3 ? 64
                    : nGroups === 2 ? 60
                    : 56;

  let confidence = 50
    + (edge - 0.5) * 40
    + (agreement - 0.5) * 12;

  if (nGroups >= 3) confidence += 2;
  if (regime === 'choppy' || regime === 'balanced') confidence += 1;
  if (regime === 'streaky' && streak >= 5) confidence += 1;

  confidence = Math.min(capByGroups, Math.max(52, Math.round(confidence)));

  if (log) {
    const { skew, leanSide } = calcSkew(log, 20);
    if (skew >= 0.65 && leanSide === pred) {
      confidence = Math.max(52, confidence - 6);
    }
    if (skew >= 0.80 && leanSide === pred) {
      confidence = Math.max(52, confidence - 8);
    }
  }

  const reasonParts = agreeing
    .sort((a, b) => b.weight - a.weight)
    .map(v => `${v.name}(${(v.accuracy * 100).toFixed(0)}%/${v.samples}/s${(v.stability * 100).toFixed(0)})`);

  return {
    predict: pred,
    confidence,
    reason: `⚡ Edge ${(edge * 100).toFixed(1)}% | Regime ${regime} | ${nGroups} nhóm: ${reasonParts.join(', ')}`,
    signals: votes.map(v => ({
      name: v.name,
      predict: v.predict,
      confidence: v.accuracy,
      detail: `${v.name} [${v.group}]: ${v.predict === 'TAI' ? 'TÀI' : 'XỈU'} (bt ${(v.accuracy * 100).toFixed(1)}%, wAcc ${((v.weightedAcc ?? v.accuracy) * 100).toFixed(1)}%, n=${v.samples}, stab ${(v.stability * 100).toFixed(0)}%)`
    })),
    context: {
      lastResult: sessions.at(-1).result,
      lastScore: sessions.at(-1).score,
      tail: seq.slice(-8).join(''),
      tailName: namePattern(seq.slice(-8).join('')),
      streak,
      regime,
      votesCount: votes.length,
      groupsAgreeing: nGroups,
      edge,
      agreement,
      capByGroups,
      backtests: Object.fromEntries(
        Object.entries(backtests).map(([k, v]) => [
          k,
          v.acc
            ? `${(v.acc * 100).toFixed(1)}% (n=${v.total}, stab=${(v.stability * 100).toFixed(0)}%)`
            : 'n/a'
        ])
      )
    }
  };
}

/* ================================================================
 *  PARSE
 * ================================================================ */
function parseLines(data) {
  if (!data || !Array.isArray(data.list)) return [];
  return data.list.map(item => {
    const score = item.point;
    return { session: item.id, dice: item.dices, score, result: normalizeResult(score) };
  }).sort((a, b) => a.session - b.session);
}

/* ================================================================
 *  GLOBAL STATE
 * ================================================================ */
let huHistory  = [];
let md5History = [];
let currentSessionIdHu  = null;
let currentSessionIdMd5 = null;
let huPredictionLog  = [];
let md5PredictionLog = [];

/* ================================================================
 *  FETCH
 * ================================================================ */
async function fetchHuData() {
  try {
    const res = await fetch(API_URL_HU);
    const data = await res.json();
    const newHistory = parseLines(data);
    if (newHistory.length === 0) return;
    const lastSession = newHistory.at(-1);

    if (!currentSessionIdHu) {
      huHistory = newHistory.slice().reverse();
      currentSessionIdHu = lastSession.session;
      console.log(`✅ [HŨ] Đã tải ${newHistory.length} phiên`);
    } else if (lastSession.session > currentSessionIdHu) {
      const newRecords = newHistory.filter(r => r.session > currentSessionIdHu);
      for (const r of newRecords) huHistory.unshift(r);
      if (huHistory.length > 1000) huHistory = huHistory.slice(0, 800);
      currentSessionIdHu = lastSession.session;
      if (newRecords.length > 0) console.log(`🆕 [HŨ] +${newRecords.length} phiên`);
    }
    verifyPredictions(huPredictionLog, huHistory);
  } catch (e) {
    console.error(`❌ [HŨ] Lỗi:`, e.message);
  }
}

async function fetchMd5Data() {
  try {
    const res = await fetch(API_URL_MD5);
    const data = await res.json();
    const newHistory = parseLines(data);
    if (newHistory.length === 0) return;
    const lastSession = newHistory.at(-1);

    if (!currentSessionIdMd5) {
      md5History = newHistory.slice().reverse();
      currentSessionIdMd5 = lastSession.session;
      console.log(`✅ [MD5] Đã tải ${newHistory.length} phiên`);
    } else if (lastSession.session > currentSessionIdMd5) {
      const newRecords = newHistory.filter(r => r.session > currentSessionIdMd5);
      for (const r of newRecords) md5History.unshift(r);
      if (md5History.length > 1000) md5History = md5History.slice(0, 800);
      currentSessionIdMd5 = lastSession.session;
      if (newRecords.length > 0) console.log(`🆕 [MD5] +${newRecords.length} phiên`);
    }
    verifyPredictions(md5PredictionLog, md5History);
  } catch (e) {
    console.error(`❌ [MD5] Lỗi:`, e.message);
  }
}
/* ================================================================
 *  PREDICTION LOG
 * ================================================================ */
function recordPrediction(log, session, prediction) {
  if (log.find(p => p.session === session)) return;
  log.push({
    session,
    predict: prediction.predict,
    confidence: prediction.confidence,
    reason: prediction.reason,
    signals: prediction.signals || [],
    actual: null,
    correct: null
  });
  if (log.length > 200) log.splice(0, log.length - 200);
}

function verifyPredictions(log, history) {
  const map = new Map(history.map(h => [h.session, h]));
  for (const p of log) {
    if (p.actual === null && map.has(p.session)) {
      const h = map.get(p.session);
      p.actual = h.result;
      p.correct = p.predict === 'NGHI' ? null : (p.predict === p.actual);
    }
  }
}

function buildHistoryReport(log, limit = 30) {
  const finished = log
    .filter(p => p.actual !== null)
    .sort((a, b) => b.session - a.session)
    .slice(0, limit);

  const valid = finished.filter(p => p.correct !== null);
  const total = valid.length;
  const dung = valid.filter(p => p.correct).length;
  const sai = total - dung;

  const history = finished.map(p => ({
    phien: p.session,
    du_doan_cu: p.predict === 'NGHI' ? 'nghỉ' : (p.predict === 'TAI' ? 'tài' : 'xỉu'),
    do_tin_cay: `${p.confidence}%`,
    ly_do: p.reason,
    ket_qua: p.actual === 'TAI' ? 'tài' : 'xỉu',
    check: p.predict === 'NGHI' ? 'bỏ qua⚪' : (p.correct ? 'đúng✅' : 'sai❌')
  }));

  return {
    history,
    thong_ke: {
      tong: total,
      dung,
      sai,
      ti_le: total > 0 ? `${(dung / total * 100).toFixed(1)}%` : '0%'
    }
  };
}

/* ================================================================
 *  MIDDLEWARE + BUILD
 * ================================================================ */
function checkKey(query) {
  const userKey = query.key;
  if (!userKey || userKey !== VALID_KEY) {
    return { valid: false, error: "sai key rồi mua key đi adSika88" };
  }
  return { valid: true };
}

function buildResponse(history, gameName, log) {
  const chronological = [...history].reverse();
  const last = history[0];
  const result = predict(chronological, log);

  recordPrediction(log, last.session + 1, result);

  const response = {
    "id": ADMIN_ID,
    "game": gameName,
    "phien_truoc": last.session,
    "xuc_xac": `${last.dice[0]} - ${last.dice[1]} - ${last.dice[2]}`,
    "ket_qua": last.result === 'TAI' ? 'tài' : 'xỉu',
    "tong": last.score,
    "phien_nay": last.session + 1,
    "du_doan": result.predict === 'NGHI' ? 'nghỉ' : (result.predict === 'TAI' ? 'tài' : 'xỉu'),
    "do_tin_cay": `${result.confidence}%`,
    "ly_do": result.reason
  };

  const skewInfo = calcSkew(log, 20);
  response.do_nghieng = {
    so_phien_xet: skewInfo.total,
    ti_le_nghieng: `${(skewInfo.skew * 100).toFixed(0)}%`,
    dang_nghieng_ve: skewInfo.leanSide === 'TAI' ? 'tài' : (skewInfo.leanSide === 'XIU' ? 'xỉu' : 'cân bằng'),
    tai: skewInfo.tai,
    xiu: skewInfo.xiu
  };

  if (result.signals && result.signals.length > 0) {
    response.chi_tiet_tin_hieu = result.signals.map(s => ({
      ten: s.name,
      du_doan: s.predict === 'TAI' ? 'tài' : 'xỉu',
      do_tin_cay: `${(s.confidence * 100).toFixed(0)}%`,
      chi_tiet: s.detail
    }));
  }

  return response;
}

/* ================================================================
 *  FASTIFY SERVER
 * ================================================================ */
const app = fastify({ logger: false });
await app.register(cors, { origin: "*" });

app.get("/", async () => ({
  status: "active",
  message: "api hỗ trợ 2 bàn hũ + md5, mua key ib adSika88",
  algorithm: "🎲 TÀI XỈU VIP v8.1 - REGIME-AWARE + DECORRELATED + SCORE-LOOKUP 🎲",
  key: VALID_KEY,
  endpoints: {
    hu:          `/api/taixiu/lc789?key=${VALID_KEY}`,
    md5:         `/api/md5/lc789?key=${VALID_KEY}`,
    hu_history:  `/api/taixiu/lc789/prediction-history?key=${VALID_KEY}`,
    md5_history: `/api/md5/lc789/prediction-history?key=${VALID_KEY}`,
    debug:       `/api/debug?key=${VALID_KEY}`
  }
}));

app.get("/api/taixiu/lc789", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  if (huHistory.length < 5) return reply.status(503).send({ error: "Đang phân tích HŨ...", current: huHistory.length });

  const res  = buildResponse(huHistory, "HŨ", huPredictionLog);
  const hist = buildHistoryReport(huPredictionLog, 30);
  return { ...res, "history": hist.history, "thong_ke": hist.thong_ke };
});

app.get("/api/md5/lc789", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  if (md5History.length < 5) return reply.status(503).send({ error: "Đang phân tích MD5...", current: md5History.length });

  const res  = buildResponse(md5History, "MD5", md5PredictionLog);
  const hist = buildHistoryReport(md5PredictionLog, 30);
  return { ...res, "history": hist.history, "thong_ke": hist.thong_ke };
});

app.get("/api/taixiu/lc789/prediction-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  const limit = Math.min(parseInt(request.query.limit) || 30, 200);
  return buildHistoryReport(huPredictionLog, limit);
});

app.get("/api/md5/lc789/prediction-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  const limit = Math.min(parseInt(request.query.limit) || 30, 200);
  return buildHistoryReport(md5PredictionLog, limit);
});

app.get("/api/taixiu/lc789/raw-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  return huHistory.slice(0, 30).map(i => ({
    session: i.session, dice: i.dice, total: i.score,
    result: i.result === 'TAI' ? 'tài' : 'xỉu'
  }));
});

app.get("/api/md5/lc789/raw-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  return md5History.slice(0, 30).map(i => ({
    session: i.session, dice: i.dice, total: i.score,
    result: i.result === 'TAI' ? 'tài' : 'xỉu'
  }));
});

app.get("/api/debug", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });

  const huSeq  = huHistory.map(x => x.result === 'TAI' ? 'B' : 'T');
  const md5Seq = md5History.map(x => x.result === 'TAI' ? 'B' : 'T');
  const huChronological = [...huHistory].reverse();
  const md5Chronological = [...md5History].reverse();

  const backtestsHu = {};
  if (huChronological.length >= 60) {
    for (const [name, fn] of Object.entries(SIGNALS_V7)) {
      backtestsHu[name] = backtestSignal(fn, huChronological);
    }
  }
  const backtestsMd5 = {};
  if (md5Chronological.length >= 60) {
    for (const [name, fn] of Object.entries(SIGNALS_V7)) {
      backtestsMd5[name] = backtestSignal(fn, md5Chronological);
    }
  }

  const fmt = (bt) => bt.acc
    ? {
        acc: `${(bt.acc * 100).toFixed(1)}%`,
        wAcc: `${((bt.weightedAcc ?? bt.acc) * 100).toFixed(1)}%`,
        samples: bt.total,
        stability: `${(bt.stability * 100).toFixed(0)}%`,
        folds: bt.folds,
        usable: bt.acc >= 0.52 && bt.total >= 15 && bt.stability >= 0.25 && (bt.weightedAcc ?? bt.acc) >= 0.52
      }
    : { acc: 'n/a', samples: bt.total, usable: false };

  const buildScoreTable = (sessions) => {
    const table = {};
    for (let s = 3; s <= 18; s++) {
      const { tai, xiu, total, pTai } = buildScoreLookup(sessions, s);
      if (total === 0) continue;
      table[s] = {
        tai, xiu, total,
        pTai: `${(pTai * 100).toFixed(1)}%`,
        nghieng: pTai > 0.56 ? 'TÀI' : pTai < 0.44 ? 'XỈU' : 'CB'
      };
    }
    return table;
  };

  return {
    hu: {
      total: huHistory.length,
      last_session: huHistory[0]?.session,
      last_result: huHistory[0]?.result,
      last_score: huHistory[0]?.score,
      last_dice: huHistory[0]?.dice,
      current_streak: currentStreak([...huSeq].reverse()),
      regime: detectRegime(huChronological),
      last_8: huSeq.slice(0, 8).join(''),
      last_8_name: namePattern(huSeq.slice(0, 8).join(''))
    },
    md5: {
      total: md5History.length,
      last_session: md5History[0]?.session,
      last_result: md5History[0]?.result,
      last_score: md5History[0]?.score,
      last_dice: md5History[0]?.dice,
      current_streak: currentStreak([...md5Seq].reverse()),
      regime: detectRegime(md5Chronological),
      last_8: md5Seq.slice(0, 8).join(''),
      last_8_name: namePattern(md5Seq.slice(0, 8).join(''))
    },
    backtests_hu: Object.fromEntries(Object.entries(backtestsHu).map(([k, v]) => [k, fmt(v)])),
    backtests_md5: Object.fromEntries(Object.entries(backtestsMd5).map(([k, v]) => [k, fmt(v)])),
    score_table_hu: buildScoreTable(huChronological),
    score_table_md5: buildScoreTable(md5Chronological),
    version: "v8.1"
  };
});

app.get("/check-key", async (request) => {
  const userKey = request.query.key;
  if (!userKey || userKey !== VALID_KEY) return { status: "error", message: "sai key rồi mua key đi adSika88" };
  return { status: "success", message: "KEY HỢP LỆ", key: VALID_KEY };
});

/* ================================================================
 *  START
 * ================================================================ */
const start = async () => {
  await Promise.all([fetchHuData(), fetchMd5Data()]);
  setInterval(fetchHuData, 5000);
  setInterval(fetchMd5Data, 5000);

  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    console.error("❌ Lỗi khởi động server:", err.message);
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  🔥 TÀI XỈU VIP v8.1 — REGIME + DECORRELATED + SCORE-LOOKUP     ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  🚀 Port ${PORT}  |  🔑 ${VALID_KEY}  |  👤 ${ADMIN_ID}`);
  console.log("║                                                                  ║");
  console.log("║  🧠 22 SIGNAL (lọc >52%, n≥15, stab≥25%):                       ║");
  console.log("║    ── MARKOV ── markov2, markov3, markov4, recentMarkov         ║");
  console.log("║    ── STREAK ── streak, betBreaker, streakScoreCombo            ║");
  console.log("║    ── SCORE ── scoreRegression, scoreNeighbor,                  ║");
  console.log("║                scoreTransition, scoreAutoCorr                   ║");
  console.log("║    ── LOOKUP ── exactScoreLookup, scoreRangeLookup,             ║");
  console.log("║                 scorePairPattern, extremeScoreBias              ║");
  console.log("║    ── PATTERN ── patternMatch, alternating, doubleBlock,        ║");
  console.log("║                  longPattern                                    ║");
  console.log("║    ── KHÁC ── momentum, diceComboMemory, dualTimeframe          ║");
  console.log("║                                                                  ║");
  console.log(`║  🔍 DEBUG: /api/debug?key=${VALID_KEY}                          ║`);
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");
};

start();