-- Restore campaigns.leads_called + increment_campaign_calls RPC
-- The column was dropped in a schema migration but the client UI
-- (CampaignCard/CampaignsTable/CampaignManagePage) still reads it, and
-- calls.ts calls the RPC on every fresh campaign call. Progress bars
-- have been rendering empty since the drop.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS leads_called integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.increment_campaign_calls(p_campaign_id uuid)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE new_count integer;
BEGIN
  UPDATE campaigns SET leads_called = leads_called + 1, updated_at = now()
   WHERE id = p_campaign_id RETURNING leads_called INTO new_count;
  RETURN new_count;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.increment_campaign_calls(uuid) TO project_admin;

-- Backfill from lead statuses joined via campaign_leads
UPDATE campaigns c SET leads_called = sub.cnt
  FROM (SELECT cl.campaign_id, count(*) AS cnt FROM campaign_leads cl
        JOIN leads l ON l.id = cl.lead_id
        WHERE coalesce(l.status,'new') NOT IN ('new','calling')
        GROUP BY cl.campaign_id) sub
 WHERE c.id = sub.campaign_id;
