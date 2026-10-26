import { expect, it } from "vitest";
import { classifyGarminCredential } from "../src/auth";

const now = 1_000;
const valid = { accessToken: "fixture-access", expiresAt: now + 1, garminUserId: "owner" };

it("treats the exact expiry boundary as unavailable without accepting expired credentials", () => {
  expect(classifyGarminCredential(valid, "owner", now)).toEqual({
    status: "allowed",
    credential: valid,
  });
  expect(classifyGarminCredential(valid, "owner", now + 1)).toEqual({ status: "unavailable" });
});

it("only a usable credential establishes an account mismatch", () => {
  expect(classifyGarminCredential(valid, "other-owner", now)).toEqual({ status: "mismatch" });
  expect(classifyGarminCredential(valid, "other-owner", now + 1)).toEqual({
    status: "unavailable",
  });
});
