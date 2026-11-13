// Prints each launch's outcome and the verdict: node print-verdict.mjs "<button label>=<logcat file>" ... (the control first)
import { readFileSync } from 'node:fs';
import { classifyLaunch, scenarios, verdictFor } from './verdict.mjs';

function launchOf(argument) {
  const separator = argument.indexOf('=');
  const label = argument.slice(0, separator);
  const scenario = scenarios.find(candidate => candidate.label === label);
  if (separator === -1 || scenario === undefined) {
    throw new Error(`"${argument}" names no button of the app`);
  }
  return { label, result: classifyLaunch(readFileSync(argument.slice(separator + 1), 'utf8'), scenario.logged) };
}

function main(argumentList) {
  if (argumentList.length !== scenarios.length) {
    throw new Error(`expected one "<button label>=<logcat file>" per button, ${scenarios.length} in all`);
  }
  const launches = argumentList.map(launchOf);
  for (const launch of launches) {
    console.log(`== ${launch.label}: ${launch.result.reason}`);
    for (const line of launch.result.evidence) {
      console.log(`   ${line}`);
    }
  }
  const [control, ...fullHeapLaunches] = launches;
  const { exitCode, summary } = verdictFor(control, fullHeapLaunches);
  console.log(`SUMMARY: ${summary}`);
  return exitCode;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.log(`step failed: the verdict: ${error.message}`);
  process.exitCode = 2;
}
