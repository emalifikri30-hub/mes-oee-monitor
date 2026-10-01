export const ALIAS_REGEX = /^[a-z0-9][a-z0-9-]*$/;
export const COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const FILENAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}\.[a-z0-9]{1,8}$/;
export const CONTENT_TYPE_REGEX = /^[a-z]+\/[a-z0-9.+-]+$/;
export const VERSION_REGEX = /^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc))?$/;
