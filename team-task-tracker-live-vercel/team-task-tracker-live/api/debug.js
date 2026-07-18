const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");

module.exports = async function handler(req, res) {
  try {
    const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
    const supabaseKey = String(
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    ).trim();

    if (!supabaseUrl) {
      return res.status(500).json({
        ok: false,
        problem: "SUPABASE_URL is missing in Vercel"
      });
    }

    if (!supabaseKey) {
      return res.status(500).json({
        ok: false,
        problem: "SUPABASE_SERVICE_ROLE_KEY is missing in Vercel"
      });
    }

    const projectRef = new URL(supabaseUrl).hostname.split(".")[0];

    const keyType = supabaseKey.startsWith("sb_secret_")
      ? "secret"
      : supabaseKey.startsWith("sb_publishable_")
      ? "WRONG — publishable key"
      : supabaseKey.split(".").length === 3
      ? "legacy service-role JWT"
      : "unknown";

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const { data, error } = await supabase
      .from("members")
      .select(
        "id, company_id, employee_id, name, role, active, pin_hash"
      )
      .ilike("employee_id", "OWNER");

    if (error) {
      return res.status(500).json({
        ok: false,
        projectRef,
        keyType,
        problem: "Supabase query failed",
        error: error.message,
        code: error.code
      });
    }

    const owners = [];

    for (const owner of data || []) {
      let pin0000Matches = false;

      try {
        pin0000Matches = await bcrypt.compare(
          "0000",
          String(owner.pin_hash || "")
        );
      } catch (error) {
        pin0000Matches = false;
      }

      owners.push({
        employeeId: owner.employee_id,
        name: owner.name,
        role: owner.role,
        active: owner.active,
        companyId: owner.company_id,
        pin0000Matches
      });
    }

    return res.status(200).json({
      ok: true,
      projectRef,
      keyType,
      ownerCount: owners.length,
      owners
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      problem: "Unexpected server error",
      error: String(error.message || error)
    });
  }
};
