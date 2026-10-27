import { expect, test } from "vitest";

import { zActivityTypeDto } from "../../src/garmin-api/personal/zod.gen.ts";
import { zWorkoutV2 } from "../../src/garmin-api/training/zod.gen.ts";

test("generated activity schemas retain Garmin extensions", () => {
  const activity = {
    typeId: 17,
    typeKey: "running",
    vendorField: "preserved",
  };

  expect(zActivityTypeDto.parse(activity)).toEqual(activity);
});

test("generated training schemas accept workouts without a provider", () => {
  const workout = { workoutName: "Push-ups", sport: "STRENGTH_TRAINING", segments: [] };

  expect(zWorkoutV2.parse(workout)).toEqual(workout);
});
