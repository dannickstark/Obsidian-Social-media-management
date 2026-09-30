export const WP_SITE = "https://eventx.berlin";
export const WP_API = `${WP_SITE}/wp-json/wp/v2`;
export const WP_PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";
export const WP_BASIC = btoa(`editor:${WP_PASSWORD}`);
/** Thu 8 Oct 2026, 17:30 Berlin. */
export const WP_AT = Date.UTC(2026, 9, 8, 15, 30);

const post = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 412,
  date: "2026-10-08T10:00:00",
  date_gmt: "2026-10-08T08:00:00",
  modified_gmt: "2026-10-08T08:00:00",
  slug: "hosting-event-x-again",
  status,
  type: "post",
  link: status === "publish" ? "https://eventx.berlin/hosting-event-x-again/" : "https://eventx.berlin/?p=412",
  title: { raw: "We're hosting Event X again", rendered: "We&#8217;re hosting Event X again" },
  ...extra,
});

export const WP = {
  post,
  future: () => post("future", { date: "2026-10-08T17:30:00", date_gmt: "2026-10-08T15:30:00" }),
  media: (id: number, file: string) => ({
    id,
    slug: file.replace(/\.\w+$/, ""),
    type: "attachment",
    media_type: "image",
    mime_type: "image/png",
    alt_text: "",
    source_url: `https://eventx.berlin/wp-content/uploads/2026/10/${file}`,
  }),
  categories: [
    { id: 5, name: "Community" },
    { id: 6, name: "Community &amp; Events" },
  ],
  createdTag: { id: 12, name: "events", slug: "events", taxonomy: "post_tag" },
  termExists: { code: "term_exists", message: "A term with the name provided already exists in this taxonomy.", data: { status: 400, term_id: 9 } },
  me: { id: 3, name: "Editor" },
  incorrectPassword: { code: "incorrect_password", message: "The provided password is an invalid application password.", data: { status: 401 } },
  cannotCreate: { code: "rest_cannot_create", message: "Sorry, you are not allowed to create posts as this user.", data: { status: 403 } },
  invalidParam: { code: "rest_invalid_param", message: "Invalid parameter(s): slug", data: { status: 400, params: { slug: "slug is not of type string." } } },
  critical: { code: "internal_server_error", message: "<p>There has been a critical error on this website.</p>", data: { status: 500 } },
  invalidId: { code: "rest_post_invalid_id", message: "Invalid post ID.", data: { status: 404 } },
  noRoute: { code: "rest_no_route", message: "No route was found matching the URL and request method.", data: { status: 404 } },
  tooMany: { code: "too_many_requests", message: "Too many requests." },
};
