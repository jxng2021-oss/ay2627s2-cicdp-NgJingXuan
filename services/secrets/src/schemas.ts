import { Type, type Static } from "typebox";

export const SECRET_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
const VERSION_CURSOR_PATTERN = "^[1-9][0-9]{0,9}$";
const MAX_VERSION = 2_147_483_647;

export const NameParams = Type.Object({
  name: Type.String({ pattern: SECRET_NAME_PATTERN }),
});

export const ValueBody = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);

export const VersionQuery = Type.Object({
  version: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_VERSION })),
});

const limit = Type.Optional(
  Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
);

export const ListQuery = Type.Object({
  limit,
  cursor: Type.Optional(Type.String({ pattern: SECRET_NAME_PATTERN })),
});

export const VersionsQuery = Type.Object({
  limit,
  cursor: Type.Optional(Type.String({ pattern: VERSION_CURSOR_PATTERN })),
});

const FILE_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export const WrapFileKeyBody = Type.Object(
  {
    fileId: Type.String({ pattern: FILE_ID_PATTERN }),
    key: Type.String({ pattern: "^[A-Za-z0-9+/]{43}=$" }),
  },
  { additionalProperties: false },
);

export const UnwrapFileKeyBody = Type.Object(
  {
    fileId: Type.String({ pattern: FILE_ID_PATTERN }),
    wrappedKey: Type.String({ pattern: "^[A-Za-z0-9+/]{87}=$" }),
  },
  { additionalProperties: false },
);

const POOL_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export const WrapSigningKeyBody = Type.Object(
  {
    poolId: Type.String({ pattern: POOL_ID_PATTERN }),
    key: Type.String({ pattern: "^[A-Za-z0-9+/]{43}=$" }),
  },
  { additionalProperties: false },
);

export const UnwrapSigningKeyBody = Type.Object(
  {
    poolId: Type.String({ pattern: POOL_ID_PATTERN }),
    wrappedKey: Type.String({ pattern: "^[A-Za-z0-9+/]{87}=$" }),
  },
  { additionalProperties: false },
);

export type NameParams = Static<typeof NameParams>;
