import {
  JsonlRootEnrollmentStore,
  RootEnrollmentService,
  SystemVolumeIdentityProvider,
} from "../enrollment/index.js";
import { ReadOnlyCanonicalPathResolver } from "../safety/index.js";
import { localStatePaths } from "./local-state.js";

async function main(): Promise<void> {
  const [stateDirectory, rootPath, displayName] = process.argv.slice(2);
  if (stateDirectory === undefined || rootPath === undefined || displayName === undefined) {
    throw new Error("Usage: root-enroll <state-directory> <root-path> <display-name>");
  }
  const paths = localStatePaths(stateDirectory);
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  const service = new RootEnrollmentService(
    canonicalizer,
    new SystemVolumeIdentityProvider(),
    new JsonlRootEnrollmentStore(paths.enrollmentsJournal),
  );
  const proposal = await service.propose({
    role: "library",
    path: rootPath,
    displayName,
  });
  const approved = await service.approve(proposal.proposalId, "local-cli");
  process.stdout.write(`${JSON.stringify(approved, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

