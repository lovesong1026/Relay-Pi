import { test } from "bun:test";

export const inDockerTest = process.env.RELAY_PI_TEST_IN_DOCKER === "1";

export const testIfDocker = inDockerTest ? test : test.skip;
