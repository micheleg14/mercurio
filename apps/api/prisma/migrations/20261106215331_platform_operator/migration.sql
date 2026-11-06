-- AlterEnum
ALTER TYPE "audit_source" ADD VALUE 'PLATFORM';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "status_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "status_reason" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "platform_operators" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "revoke_reason" TEXT,

    CONSTRAINT "platform_operators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_operators_user_id_idx" ON "platform_operators"("user_id");

-- AddForeignKey
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================================
-- Written by hand (phase 8a, docs/adr/0038). Everything above is compatible with 1.1.x (B13):
-- new columns with defaults, a new table, a new enum value the old code never reads.
-- ===========================================================================================

-- Platform operators: at most one open grant per person; a revocation keeps the row.
CREATE UNIQUE INDEX "platform_operators_one_open_grant" ON "platform_operators" (user_id)
  WHERE revoked_at IS NULL;
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_revocation"
  CHECK (revoked_at IS NOT NULL OR (revoked_by IS NULL AND revoke_reason IS NULL));
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_reason"
  CHECK (revoke_reason IS NULL OR btrim(revoke_reason) <> '');

-- A platform table: a person reads only their own grants, to know whether they are an operator.
-- Nobody writes it through the API: grants come from the terminal (phase 8b adds the browser).
ALTER TABLE "platform_operators" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_operators" FORCE ROW LEVEL SECURITY;
CREATE POLICY own_operator_grants ON "platform_operators" FOR SELECT
  USING (user_id = app_user_id());
GRANT SELECT ON "platform_operators" TO mercurio_app;

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_reason"
  CHECK (status_reason IS NULL OR btrim(status_reason) <> '');

-- ---------------------------------------------------------------------------------------------
-- Helpers. Not SECURITY DEFINER: they run with the rights of whoever calls them, which for the
-- app_platform_* functions below is the owner.
-- ---------------------------------------------------------------------------------------------

-- True when the current person holds an open operator grant. The API calls it on every request
-- to a platform route (through the policy above it sees only its own rows).
CREATE FUNCTION app_platform_operator_active() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_operators o
    WHERE o.user_id = app_user_id() AND o.revoked_at IS NULL
  )
$$;
REVOKE EXECUTE ON FUNCTION app_platform_operator_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_operator_active() TO mercurio_app;

-- The first statement of every app_platform_* function: the API checks it already, but a mistake
-- there must never become access to every tenant.
CREATE FUNCTION mercurio_platform_assert_operator() RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NOT app_platform_operator_active() THEN
    RAISE EXCEPTION 'NOT_PLATFORM_OPERATOR' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION mercurio_platform_assert_operator() FROM PUBLIC;

-- UUID version 7 (RFC 9562): 48 bits of Unix milliseconds, then random bits. PostgreSQL 17 has
-- no uuidv7(); the application generates its own ids, these are for rows the functions create.
CREATE FUNCTION mercurio_uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog, public
  AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                                FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;
REVOKE EXECUTE ON FUNCTION mercurio_uuid_v7() FROM PUBLIC;

-- The module keys of MODULE_CATALOG (module-catalog.ts), checked against it by a test. Only the
-- keys: which module needs which stays in the code, in one place.
CREATE FUNCTION mercurio_module_keys() RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$ SELECT ARRAY['registry', 'warehouse', 'orders', 'invoicing']::text[] $$;
REVOKE EXECUTE ON FUNCTION mercurio_module_keys() FROM PUBLIC;

-- What the functions recheck about a list of modules computed by applyModuleChange.
CREATE FUNCTION mercurio_platform_assert_modules(p_modules text[]) RETURNS void
  LANGUAGE plpgsql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF p_modules IS NULL OR NOT (p_modules <@ mercurio_module_keys())
     OR NOT ('registry' = ANY (p_modules)) THEN
    RAISE EXCEPTION 'INVALID_MODULES' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION mercurio_platform_assert_modules(text[]) FROM PUBLIC;

-- An event in the audit log of a tenant, written by the current operator.
CREATE FUNCTION mercurio_platform_audit(
  p_tenant uuid, p_type text, p_subject_type text, p_subject_id uuid, p_details jsonb
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  INSERT INTO public.audit_events (id, tenant_id, actor_user_id, source, type, subject_type,
                                   subject_id, details)
  VALUES (mercurio_uuid_v7(), p_tenant, app_user_id(), 'PLATFORM', p_type, p_subject_type,
          p_subject_id, p_details);
END
$$;
REVOKE EXECUTE ON FUNCTION mercurio_platform_audit(uuid, text, text, uuid, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER functions of the platform operator (B28). Each one checks the operator first,
-- does only its own operation and records it in the tenant's audit log in the same transaction.
-- Rules (names, slugs, VAT numbers, module dependencies) are applied by the code before: these
-- recheck only what guards the boundary. None of them reads business data of a tenant.
-- ---------------------------------------------------------------------------------------------

-- The tenants, with what configuring them needs and nothing more (search on name or slug).
CREATE FUNCTION app_platform_list_tenants(
  p_search text, p_status tenant_status, p_limit integer, p_offset integer
)
  RETURNS TABLE (
    id uuid, name text, slug text, status tenant_status, modules text[], companies integer,
    people integer, created_at timestamptz, total bigint
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM mercurio_platform_assert_operator();
  RETURN QUERY
    SELECT t.id, t.name, t.slug, t.status,
           ARRAY(SELECT m.module_key FROM public.tenant_modules m
                 WHERE m.tenant_id = t.id ORDER BY m.module_key),
           (SELECT count(*)::integer FROM public.companies c WHERE c.tenant_id = t.id),
           (SELECT count(*)::integer FROM public.memberships m
            WHERE m.tenant_id = t.id AND m.status = 'ACTIVE'),
           t.created_at,
           count(*) OVER ()
    FROM public.tenants t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (p_search IS NULL OR t.name ILIKE '%' || p_search || '%'
           OR t.slug ILIKE '%' || p_search || '%')
    ORDER BY t.name, t.id
    LIMIT p_limit OFFSET p_offset;
END
$$;

-- One tenant: its data, companies (name and VAT number only), administrators and how many other
-- people work there. Null when there is no such tenant.
CREATE FUNCTION app_platform_get_tenant(p_tenant uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM mercurio_platform_assert_operator();
  RETURN (
    SELECT jsonb_build_object(
      'id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status,
      'statusReason', t.status_reason, 'statusChangedAt', t.status_changed_at,
      'version', t.version, 'createdAt', t.created_at,
      'modules', to_jsonb(ARRAY(SELECT m.module_key FROM public.tenant_modules m
                                WHERE m.tenant_id = t.id ORDER BY m.module_key)),
      'companies', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', c.id, 'legalName', c.legal_name,
                                            'vatNumber', c.vat_number, 'country', c.country)
                         ORDER BY c.legal_name, c.id)
        FROM public.companies c WHERE c.tenant_id = t.id), '[]'::jsonb),
      'admins', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'membershipId', m.id, 'userId', u.id, 'name', u.name, 'email', u.email,
                 'activated', EXISTS (SELECT 1 FROM public.credentials c WHERE c.user_id = u.id),
                 'otherTenants', EXISTS (SELECT 1 FROM public.memberships o
                                         WHERE o.user_id = u.id AND o.tenant_id <> t.id
                                           AND o.status = 'ACTIVE'),
                 'lastSeenAt', (SELECT max(s.last_used_at) FROM public.sessions s
                                WHERE s.user_id = u.id AND s.selected_tenant_id = t.id))
                 ORDER BY u.name, u.id)
        FROM public.memberships m JOIN public.users u ON u.id = m.user_id
        WHERE m.tenant_id = t.id AND m.status = 'ACTIVE' AND m.role = 'ADMIN'), '[]'::jsonb),
      'otherPeople', (SELECT count(*) FROM public.memberships m
                      WHERE m.tenant_id = t.id AND m.status = 'ACTIVE'
                        AND m.role IS DISTINCT FROM 'ADMIN')
    )
    FROM public.tenants t WHERE t.id = p_tenant
  );
END
$$;

-- What operators did on a tenant, newest first. Only PLATFORM events: what the people of the
-- tenant do is not the operator's business.
CREATE FUNCTION app_platform_tenant_events(p_tenant uuid, p_limit integer, p_offset integer)
  RETURNS TABLE (
    id uuid, type text, actor_name text, subject_type text, subject_id uuid, details jsonb,
    at timestamptz, total bigint
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM mercurio_platform_assert_operator();
  RETURN QUERY
    SELECT e.id, e.type, u.name, e.subject_type, e.subject_id, e.details, e.at, count(*) OVER ()
    FROM public.audit_events e LEFT JOIN public.users u ON u.id = e.actor_user_id
    WHERE e.tenant_id = p_tenant AND e.source = 'PLATFORM'
    ORDER BY e.at DESC, e.id DESC
    LIMIT p_limit OFFSET p_offset;
END
$$;

-- A new tenant with its first company, modules and first administrator, in one go: the same
-- steps as create-tenant. An administrator whose email is already known keeps their identity and
-- gets no code; a new identity gets the code whose hash is given here (the code itself is shown
-- once by the API). Outcome: OK, SLUG_EXISTS or USER_DISABLED.
CREATE FUNCTION app_platform_create_tenant(
  p_name text, p_slug text,
  p_legal_name text, p_vat_number text, p_tax_code text, p_country text,
  p_modules text[],
  p_admin_email text, p_admin_name text, p_code_hash text, p_code_expires_at timestamptz
)
  RETURNS TABLE (
    outcome text, tenant_id uuid, company_id uuid, membership_id uuid, user_id uuid,
    identity_created boolean
  )
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := mercurio_uuid_v7();
  v_company uuid := mercurio_uuid_v7();
  v_membership uuid := mercurio_uuid_v7();
  v_person record;
  v_email text := lower(btrim(p_admin_email));
BEGIN
  PERFORM mercurio_platform_assert_operator();
  PERFORM mercurio_platform_assert_modules(p_modules);

  BEGIN
    INSERT INTO public.tenants (id, name, slug, updated_at)
    VALUES (v_tenant, p_name, p_slug, now());
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'SLUG_EXISTS', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, false;
    RETURN;
  END;

  SELECT * INTO v_person FROM app_find_or_create_person(mercurio_uuid_v7(), v_email, p_admin_name);
  IF v_person.status <> 'ACTIVE' THEN
    -- Nothing is kept: the exception undoes the tenant, and a person created here too.
    RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.companies (id, tenant_id, legal_name, vat_number, tax_code, country,
                                updated_at)
  VALUES (v_company, v_tenant, p_legal_name, p_vat_number, p_tax_code, p_country, now());
  INSERT INTO public.tenant_modules (tenant_id, module_key)
  SELECT v_tenant, k FROM unnest(p_modules) AS k;
  INSERT INTO public.memberships (id, tenant_id, user_id, role, all_companies, updated_at)
  VALUES (v_membership, v_tenant, v_person.user_id, 'ADMIN', true, now());
  IF v_person.created THEN
    INSERT INTO public.activation_tokens (id, user_id, token_hash, expires_at)
    VALUES (mercurio_uuid_v7(), v_person.user_id, p_code_hash, p_code_expires_at);
  END IF;

  PERFORM mercurio_platform_audit(v_tenant, 'TENANT_CREATED', 'tenant', v_tenant,
    jsonb_build_object('slug', p_slug, 'modules', to_jsonb(p_modules)));
  PERFORM mercurio_platform_audit(v_tenant, 'MEMBER_ADDED', 'membership', v_membership,
    jsonb_build_object('email', v_email, 'role', 'ADMIN', 'companies', 'all',
                       'identity', CASE WHEN v_person.created THEN 'new' ELSE 'existing' END));
  IF v_person.created THEN
    PERFORM mercurio_platform_audit(v_tenant, 'ACTIVATION_CODE_ISSUED', 'membership',
      v_membership, jsonb_build_object('email', v_email, 'expiresAt', p_code_expires_at));
  END IF;

  RETURN QUERY SELECT 'OK', v_tenant, v_company, v_membership, v_person.user_id, v_person.created;
END
$$;

-- Replaces the modules of a tenant with the final list computed by applyModuleChange, at the
-- version the operator saw (B29). Outcome: OK, NOT_FOUND or EDIT_CONFLICT; the new version.
CREATE FUNCTION app_platform_set_modules(p_tenant uuid, p_version integer, p_modules text[])
  RETURNS TABLE (outcome text, version integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_version integer;
  v_current text[];
  v_enabled text[];
  v_disabled text[];
BEGIN
  PERFORM mercurio_platform_assert_operator();
  PERFORM mercurio_platform_assert_modules(p_modules);
  SELECT t.version INTO v_version FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::integer; RETURN;
  END IF;
  IF v_version <> p_version THEN
    RETURN QUERY SELECT 'EDIT_CONFLICT', v_version; RETURN;
  END IF;

  v_current := ARRAY(SELECT m.module_key FROM public.tenant_modules m WHERE m.tenant_id = p_tenant);
  v_enabled := ARRAY(SELECT k FROM unnest(p_modules) k WHERE NOT k = ANY (v_current) ORDER BY k);
  v_disabled := ARRAY(SELECT k FROM unnest(v_current) k WHERE NOT k = ANY (p_modules) ORDER BY k);
  IF cardinality(v_enabled) = 0 AND cardinality(v_disabled) = 0 THEN
    RETURN QUERY SELECT 'OK', v_version; RETURN;
  END IF;

  DELETE FROM public.tenant_modules m WHERE m.tenant_id = p_tenant AND m.module_key = ANY (v_disabled);
  INSERT INTO public.tenant_modules (tenant_id, module_key)
  SELECT p_tenant, k FROM unnest(v_enabled) AS k;
  UPDATE public.tenants t SET version = t.version + 1, updated_at = now() WHERE t.id = p_tenant;

  PERFORM mercurio_platform_audit(p_tenant, 'MODULES_CHANGED', 'tenant', p_tenant,
    jsonb_build_object(
      'modules', to_jsonb(ARRAY(SELECT k FROM unnest(p_modules) k ORDER BY k)),
      'enabled', to_jsonb(v_enabled), 'disabled', to_jsonb(v_disabled)));
  RETURN QUERY SELECT 'OK', v_version + 1;
END
$$;

-- A new name; the slug never changes (commands, logs and the audit use it).
-- Outcome: OK, NOT_FOUND or EDIT_CONFLICT; the new version.
CREATE FUNCTION app_platform_rename_tenant(p_tenant uuid, p_version integer, p_name text)
  RETURNS TABLE (outcome text, version integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant record;
BEGIN
  PERFORM mercurio_platform_assert_operator();
  SELECT t.name, t.version INTO v_tenant FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::integer; RETURN;
  END IF;
  IF v_tenant.version <> p_version THEN
    RETURN QUERY SELECT 'EDIT_CONFLICT', v_tenant.version; RETURN;
  END IF;
  IF v_tenant.name = p_name THEN
    RETURN QUERY SELECT 'OK', v_tenant.version; RETURN;
  END IF;
  UPDATE public.tenants t SET name = p_name, version = t.version + 1, updated_at = now()
  WHERE t.id = p_tenant;
  PERFORM mercurio_platform_audit(p_tenant, 'TENANT_RENAMED', 'tenant', p_tenant,
    jsonb_build_object('before', v_tenant.name, 'after', p_name));
  RETURN QUERY SELECT 'OK', v_tenant.version + 1;
END
$$;

-- Suspends or reactivates a tenant, with a reason. A suspended tenant refuses every request of
-- its people at once (resolveIdentity); nothing is deleted. Outcome: OK, NOT_FOUND,
-- EDIT_CONFLICT, REASON_REQUIRED or STATUS_UNCHANGED; the new version.
CREATE FUNCTION app_platform_set_tenant_status(
  p_tenant uuid, p_version integer, p_status tenant_status, p_reason text
)
  RETURNS TABLE (outcome text, version integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant record;
  v_reason text := btrim(p_reason);
BEGIN
  PERFORM mercurio_platform_assert_operator();
  IF v_reason IS NULL OR v_reason = '' THEN
    RETURN QUERY SELECT 'REASON_REQUIRED', NULL::integer; RETURN;
  END IF;
  SELECT t.status, t.version INTO v_tenant FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::integer; RETURN;
  END IF;
  IF v_tenant.version <> p_version THEN
    RETURN QUERY SELECT 'EDIT_CONFLICT', v_tenant.version; RETURN;
  END IF;
  IF v_tenant.status = p_status THEN
    RETURN QUERY SELECT 'STATUS_UNCHANGED', v_tenant.version; RETURN;
  END IF;
  UPDATE public.tenants t
  SET status = p_status, status_reason = v_reason, status_changed_at = now(),
      version = t.version + 1, updated_at = now()
  WHERE t.id = p_tenant;
  PERFORM mercurio_platform_audit(p_tenant,
    CASE p_status WHEN 'SUSPENDED' THEN 'TENANT_SUSPENDED' ELSE 'TENANT_REACTIVATED' END,
    'tenant', p_tenant, jsonb_build_object('reason', v_reason));
  RETURN QUERY SELECT 'OK', v_tenant.version + 1;
END
$$;

-- An administrator for a tenant, for example when its only one has left. A new identity gets the
-- code whose hash is given; a known one keeps its credentials. A member with another role becomes
-- ADMIN with every company only when p_promote says the operator confirmed it.
-- Outcome: ADDED, PROMOTED, NEEDS_PROMOTION (with the current role), ALREADY_ADMIN, NOT_FOUND or
-- USER_DISABLED.
CREATE FUNCTION app_platform_add_admin(
  p_tenant uuid, p_email text, p_name text, p_promote boolean,
  p_code_hash text, p_code_expires_at timestamptz
)
  RETURNS TABLE (
    outcome text, membership_id uuid, user_id uuid, identity_created boolean, member_role text
  )
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(btrim(p_email));
  v_person record;
  v_member record;
  v_role text;
  v_membership uuid;
BEGIN
  PERFORM mercurio_platform_assert_operator();
  -- Lock order (B34): tenant, person, membership.
  PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::uuid, NULL::uuid, false, NULL::text; RETURN;
  END IF;

  SELECT * INTO v_person FROM app_find_or_create_person(mercurio_uuid_v7(), v_email, p_name);
  IF v_person.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = v_person.user_id FOR UPDATE;

  SELECT m.id, m.status, m.role, r.name AS custom_name INTO v_member
  FROM public.memberships m LEFT JOIN public.tenant_roles r ON r.id = m.custom_role_id
  WHERE m.tenant_id = p_tenant AND m.user_id = v_person.user_id
  FOR UPDATE OF m;

  IF FOUND AND v_member.status = 'ACTIVE' THEN
    v_role := COALESCE(v_member.role::text, v_member.custom_name);
    IF v_member.role = 'ADMIN' THEN
      RETURN QUERY SELECT 'ALREADY_ADMIN', v_member.id, v_person.user_id, false, v_role; RETURN;
    END IF;
    IF NOT p_promote THEN
      RETURN QUERY SELECT 'NEEDS_PROMOTION', v_member.id, v_person.user_id, false, v_role; RETURN;
    END IF;
    UPDATE public.memberships m
    SET role = 'ADMIN', custom_role_id = NULL, all_companies = true,
        version = m.version + 1, updated_at = now()
    WHERE m.id = v_member.id;
    DELETE FROM public.membership_companies mc WHERE mc.membership_id = v_member.id;
    PERFORM mercurio_platform_audit(p_tenant, 'MEMBER_UPDATED', 'membership', v_member.id,
      jsonb_build_object('email', v_email, 'fields', jsonb_build_array('role', 'companies'),
                         'roleBefore', v_role, 'roleAfter', 'ADMIN'));
    RETURN QUERY SELECT 'PROMOTED', v_member.id, v_person.user_id, false, v_role; RETURN;
  END IF;

  IF FOUND THEN
    -- A removed membership comes back, as for the tenant administrator (phase 7).
    v_membership := v_member.id;
    UPDATE public.memberships m
    SET status = 'ACTIVE', role = 'ADMIN', custom_role_id = NULL, all_companies = true,
        version = m.version + 1, updated_at = now()
    WHERE m.id = v_membership;
    DELETE FROM public.membership_companies mc WHERE mc.membership_id = v_membership;
  ELSE
    v_membership := mercurio_uuid_v7();
    INSERT INTO public.memberships (id, tenant_id, user_id, role, all_companies, updated_at)
    VALUES (v_membership, p_tenant, v_person.user_id, 'ADMIN', true, now());
  END IF;
  IF v_person.created THEN
    INSERT INTO public.activation_tokens (id, user_id, token_hash, expires_at)
    VALUES (mercurio_uuid_v7(), v_person.user_id, p_code_hash, p_code_expires_at);
  END IF;

  PERFORM mercurio_platform_audit(p_tenant, 'MEMBER_ADDED', 'membership', v_membership,
    jsonb_build_object('email', v_email, 'role', 'ADMIN', 'companies', 'all',
                       'identity', CASE WHEN v_person.created THEN 'new' ELSE 'existing' END));
  IF v_person.created THEN
    PERFORM mercurio_platform_audit(p_tenant, 'ACTIVATION_CODE_ISSUED', 'membership',
      v_membership, jsonb_build_object('email', v_email, 'expiresAt', p_code_expires_at));
  END IF;
  RETURN QUERY SELECT 'ADDED', v_membership, v_person.user_id, v_person.created, NULL::text;
END
$$;

-- A new activation code for an administrator who has not activated their account yet, with the
-- conditions of app_issue_activation_code: never for an active account, never for someone who
-- works for other tenants too (a code resets the credentials everywhere). Recovering an active
-- account is phase 8b. Outcome: OK, NOT_ADMIN, ALREADY_ACTIVATED or OTHER_TENANTS.
CREATE FUNCTION app_platform_issue_admin_code(
  p_tenant uuid, p_user uuid, p_code_hash text, p_expires_at timestamptz
)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_membership uuid;
  v_email text;
BEGIN
  PERFORM mercurio_platform_assert_operator();
  SELECT u.email INTO v_email FROM public.users u
  WHERE u.id = p_user AND u.status = 'ACTIVE' FOR UPDATE;
  SELECT m.id INTO v_membership FROM public.memberships m
  WHERE m.user_id = p_user AND m.tenant_id = p_tenant AND m.status = 'ACTIVE'
    AND m.role = 'ADMIN';
  IF v_email IS NULL OR v_membership IS NULL THEN
    RETURN 'NOT_ADMIN';
  END IF;
  IF EXISTS (SELECT 1 FROM public.credentials c WHERE c.user_id = p_user) THEN
    RETURN 'ALREADY_ACTIVATED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = p_user AND m.tenant_id <> p_tenant AND m.status = 'ACTIVE'
  ) THEN
    RETURN 'OTHER_TENANTS';
  END IF;
  DELETE FROM public.activation_tokens t WHERE t.user_id = p_user AND t.used_at IS NULL;
  INSERT INTO public.activation_tokens (id, user_id, token_hash, expires_at)
  VALUES (mercurio_uuid_v7(), p_user, p_code_hash, p_expires_at);
  PERFORM mercurio_platform_audit(p_tenant, 'ACTIVATION_CODE_ISSUED', 'membership', v_membership,
    jsonb_build_object('email', v_email, 'expiresAt', p_expires_at));
  RETURN 'OK';
END
$$;

REVOKE EXECUTE ON FUNCTION app_platform_list_tenants(text, tenant_status, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_get_tenant(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_tenant_events(uuid, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_create_tenant(text, text, text, text, text, text, text[], text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_set_modules(uuid, integer, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_rename_tenant(uuid, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_set_tenant_status(uuid, integer, tenant_status, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_add_admin(uuid, text, text, boolean, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_issue_admin_code(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_list_tenants(text, tenant_status, integer, integer) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_get_tenant(uuid) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_tenant_events(uuid, integer, integer) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_create_tenant(text, text, text, text, text, text, text[], text, text, text, timestamptz) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_set_modules(uuid, integer, text[]) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_rename_tenant(uuid, integer, text) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_set_tenant_status(uuid, integer, tenant_status, text) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_add_admin(uuid, text, text, boolean, text, timestamptz) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_issue_admin_code(uuid, uuid, text, timestamptz) TO mercurio_app;
