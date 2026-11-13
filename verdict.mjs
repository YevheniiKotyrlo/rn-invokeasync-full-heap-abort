// Decides from a launch's logcat whether the app's post through CallInvoker::invokeAsync ended the process.
export const postingThread = 'full-heap-post';

export const scenarios = [
  { label: 'Post with the Java heap free', logged: 'Java heap free, posting thread never attached' },
  { label: 'Post from a new thread with the Java heap full', logged: 'Java heap full, posting thread never attached' },
  {
    label: 'Post from an attached thread with the Java heap full',
    logged: 'Java heap full, posting thread attached first',
  },
];

const appTag = 'FullHeapPost';
const appMessage = {
  scenario: /^scenario: (.*)$/,
  filled: /^Java heap filled: /,
  posting: /^posting the callback /,
  returned: /^invokeAsync returned$/,
  callbackRan: /^the posted callback ran on the JS thread$/,
  callbackMissing: /^the posted callback did not run within 5 s$/,
};

const logLine = /^\S+ \S+\s+(\d+)\s+(\d+) [VDIWEFA] (.*?)\s*: (.*)$/;
const fatalSignal = /^Fatal signal \d+ \((SIG[A-Z]+)\).* in tid \d+ \(([^)]*)\), pid (\d+) \(/;
const tombstoneHeader = /^pid: (\d+), tid: \d+, name: /;
const frame = /^\s*#(\d+) pc [0-9a-f]+\s+(.*)$/;
const invokeAsyncFrame = /(\w*CallInvoker\w*)::invokeAsync\(/;

function parse(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = logLine.exec(line);
    return match === null ? [] : [{ pid: match[1], tag: match[3], message: match[4] }];
  });
}

function describeFrame(number, location) {
  const withoutBuildId = location.replace(/\s*\(BuildId: [0-9a-f]+\)$/, '').replace(/\s*\(offset 0x[0-9a-f]+\)/, '');
  const library = /([^/!\s]+\.so)\b/.exec(withoutBuildId)?.[1] ?? withoutBuildId.split(/\s/)[0];
  const symbolStart = withoutBuildId.indexOf(' (');
  const symbol = symbolStart === -1 ? '' : ` ${withoutBuildId.slice(symbolStart + 2, -1)}`;
  return `#${number.padStart(2, '0')} ${library}${symbol}`;
}

// crash_dump logs a tombstone from its own process; its header line names the process that crashed.
function tombstoneOf(lines, appPid) {
  const header = lines.find(line => line.tag === 'DEBUG' && tombstoneHeader.exec(line.message)?.[1] === appPid);
  if (header === undefined) {
    return { abortMessage: undefined, frames: [] };
  }
  const messages = lines.filter(line => line.tag === 'DEBUG' && line.pid === header.pid).map(line => line.message);
  const frames = messages.flatMap(message => {
    const match = frame.exec(message);
    return match === null ? [] : [describeFrame(match[1], match[2])];
  });
  const lastFrameOfApp = frames.findIndex(described => described.includes('libappmodules.so'));
  return {
    abortMessage: messages.find(message => message.startsWith('Abort message:')),
    frames: lastFrameOfApp === -1 ? frames : frames.slice(0, lastFrameOfApp + 1),
  };
}

export function classifyLaunch(text, expectedScenario) {
  const lines = parse(text);
  const scenarioLines = lines.filter(line => line.tag === appTag && appMessage.scenario.test(line.message));
  const result = (state, reason, evidence = []) => ({ state, reason, evidence });
  if (scenarioLines.length === 0) {
    return result('other', 'the app never logged its scenario');
  }
  const scenarioLine = scenarioLines.at(-1);
  const appPid = scenarioLine.pid;
  const scenario = appMessage.scenario.exec(scenarioLine.message)[1];
  if (scenario !== expectedScenario) {
    return result('other', `the app logged the scenario "${scenario}", not "${expectedScenario}"`);
  }

  const appLines = lines.filter(line => line.pid === appPid);
  const appMessages = appLines.filter(line => line.tag === appTag).map(line => line.message);
  const has = pattern => appMessages.some(message => pattern.test(message));
  const posting = has(appMessage.posting);
  const returned = has(appMessage.returned);
  const callbackRan = has(appMessage.callbackRan);
  const signal = appLines.map(line => fatalSignal.exec(line.message)).find(match => match !== null && match[3] === appPid);
  const tombstone = tombstoneOf(lines, appPid);
  const javaCrash = appLines.find(line => line.message.startsWith('FATAL EXCEPTION: '));
  const peerFailure = appLines.find(line => line.message === `Exception creating thread peer: ${postingThread}`);
  const evidence = [
    ...appMessages.filter(message => appMessage.filled.test(message) || appMessage.posting.test(message)),
    ...(peerFailure === undefined ? [] : [peerFailure.message]),
    ...(signal === undefined ? [] : [`Fatal signal ${signal[1]} in ${signal[2]}`]),
    ...(signal === undefined || tombstone.abortMessage === undefined ? [] : [tombstone.abortMessage]),
    ...(signal === undefined ? [] : tombstone.frames),
  ];

  if (signal !== undefined) {
    const invokeAsync = tombstone.frames.map(described => invokeAsyncFrame.exec(described)).find(match => match !== null);
    if (signal[2] === postingThread && posting && !returned && invokeAsync !== undefined) {
      return result('ended-in-post', `${signal[1]} in ${postingThread} inside ${invokeAsync[1]}::invokeAsync`, evidence);
    }
    const when = posting ? '' : ' before the post';
    return result('other', `${signal[1]} in ${signal[2]}${when}, not inside the post's invokeAsync`, evidence);
  }
  if (javaCrash !== undefined) {
    return result('other', `a Java exception ended the process: ${javaCrash.message}`, evidence);
  }
  if (!posting) {
    return result('other', 'the posting thread never posted', evidence);
  }
  if (returned && callbackRan) {
    return result('survived', 'invokeAsync returned and the callback ran on the JS thread', evidence);
  }
  if (returned && has(appMessage.callbackMissing)) {
    return result('dropped', 'invokeAsync returned, and the callback never ran', evidence);
  }
  return result('other', 'the launch ended before the post settled', evidence);
}

function namesOf(launches) {
  return launches.map(launch => `"${launch.label}"`).join(' and ');
}

export function verdictFor(control, fullHeapLaunches) {
  if (control.result.state !== 'survived') {
    return { exitCode: 2, summary: `the control did not run its callback: ${control.result.reason}` };
  }
  const ended = fullHeapLaunches.filter(launch => launch.result.state === 'ended-in-post');
  const unsettled = fullHeapLaunches.filter(launch => launch.result.state !== 'survived');
  if (ended.length > 0) {
    const rest = unsettled.filter(launch => launch.result.state !== 'ended-in-post');
    const restNote = rest.length > 0 ? `; ${namesOf(rest)} ended another way` : '';
    return {
      exitCode: 1,
      summary: `with the Java heap full, the process ended inside invokeAsync in ${namesOf(ended)}${restNote}; with the heap free the callback ran`,
    };
  }
  if (unsettled.length === 0) {
    return { exitCode: 0, summary: 'with the Java heap full, every post returned from invokeAsync and its callback ran' };
  }
  const reasons = unsettled.map(launch => launch.result.reason).join('; ');
  return { exitCode: 2, summary: `no launch ended inside invokeAsync, and ${namesOf(unsettled)} ended another way: ${reasons}` };
}
