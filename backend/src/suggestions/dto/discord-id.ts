/**
 * A Discord snowflake, as a string of digits.
 *
 * 17 to 20 digits: snowflakes are 64-bit, the oldest ids in use are 17 digits
 * and the range will not exceed 20 before 2090. Validated as a **string** and
 * never as a number — above 2^53 a JSON number silently loses precision, and an
 * id that is off by one identifies a different person.
 */
export const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export const DISCORD_SNOWFLAKE_MESSAGE =
  'must be a Discord snowflake (17-20 digits, as a string)';
