/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cache Components is deliberately left off: it retires `export const dynamic`,
  // and this tool relies on `force-dynamic` so that edits made directly in the
  // Supabase table editor show up on a plain browser refresh (no redeploy).
};

export default nextConfig;
