import { afterAll } from "vitest";

import { dropFileSchema } from "./postgres.js";

afterAll(dropFileSchema);
