import { Type, type Static } from "typebox";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./passwords.js";

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export const PoolName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$",
});
const AccessTtl = Type.Integer({ minimum: 60, maximum: 86_400 });
const RefreshTtl = Type.Integer({ minimum: 3_600, maximum: 90 * 86_400 });
const MinPasswordLength = Type.Integer({
  minimum: MIN_PASSWORD_LENGTH,
  maximum: 64,
});

export const NewPoolBody = Type.Object(
  {
    name: PoolName,
    accessTokenTtlSeconds: Type.Optional(AccessTtl),
    refreshTokenTtlSeconds: Type.Optional(RefreshTtl),
    minPasswordLength: Type.Optional(MinPasswordLength),
  },
  { additionalProperties: false },
);
export const PoolChangesBody = Type.Object(
  {
    name: Type.Optional(PoolName),
    accessTokenTtlSeconds: Type.Optional(AccessTtl),
    refreshTokenTtlSeconds: Type.Optional(RefreshTtl),
    minPasswordLength: Type.Optional(MinPasswordLength),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const Email = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
});
export const Password = Type.String({
  minLength: 1,
  maxLength: MAX_PASSWORD_LENGTH,
});
export const Attributes = Type.Record(
  Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,39}$" }),
  Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Boolean()]),
  { maxProperties: 20, additionalProperties: false },
);

export const SignUpBody = Type.Object(
  { email: Email, password: Password, attributes: Type.Optional(Attributes) },
  { additionalProperties: false },
);
export const LoginBody = Type.Object(
  { email: Email, password: Password },
  { additionalProperties: false },
);
export const RefreshToken = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
export const RefreshBody = Type.Object(
  { refreshToken: RefreshToken },
  { additionalProperties: false },
);
export const UserChangesBody = Type.Object(
  {
    status: Type.Optional(Type.Enum(["active", "disabled"])),
    attributes: Type.Optional(Attributes),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const ChangePasswordBody = Type.Object(
  { currentPassword: Password, newPassword: Password },
  { additionalProperties: false },
);

export const PoolParams = Type.Object({
  poolId: Type.String({ pattern: UUID }),
});
export const UserParams = Type.Object({
  poolId: Type.String({ pattern: UUID }),
  userId: Type.String({ pattern: UUID }),
});
export const UserListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  cursor: Type.Optional(Type.String({ pattern: UUID })),
  email: Type.Optional(Type.String({ minLength: 1, maxLength: 254 })),
});

export const RoleName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9_.:-]{0,63}$",
});
export const Permission = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^(\\*|[A-Za-z0-9][A-Za-z0-9_.:-]{0,98}(:\\*|\\.\\*)?)$",
});
export const Permissions = Type.Array(Permission, {
  maxItems: 100,
  uniqueItems: true,
});
const Description = Type.String({ maxLength: 200 });

export const NewRoleBody = Type.Object(
  {
    name: RoleName,
    description: Type.Optional(Description),
    permissions: Permissions,
  },
  { additionalProperties: false },
);
export const RoleChangesBody = Type.Object(
  {
    description: Type.Optional(Description),
    permissions: Type.Optional(Permissions),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const RoleParams = Type.Object({
  poolId: Type.String({ pattern: UUID }),
  role: RoleName,
});
export const UserRoleParams = Type.Object({
  poolId: Type.String({ pattern: UUID }),
  userId: Type.String({ pattern: UUID }),
  role: RoleName,
});

export type NewPoolBody = Static<typeof NewPoolBody>;
export type PoolChangesBody = Static<typeof PoolChangesBody>;
export type Attributes = Static<typeof Attributes>;
