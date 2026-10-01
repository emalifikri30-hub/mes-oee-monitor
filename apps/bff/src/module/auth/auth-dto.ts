type OrganizationInfo = {
  [key: string]: {
    id: string;
  };
};

type ResourceAccess = Record<string, { roles: string[] }>;

type MeResponse = {
  sub: string;
  preferredUsername: string;
  email: string;
  resourceAccess: ResourceAccess;
  organization: OrganizationInfo;
};

type MeStatusResponse = {
  message: string;
};

type ErrorResponse = {
  error: string;
};

export type { MeResponse, MeStatusResponse, ErrorResponse, OrganizationInfo, ResourceAccess };
