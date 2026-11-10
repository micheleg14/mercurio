-- ===========================================================================================
-- Written by hand (phase 8b, docs/adr/0039): companies, account recovery and operators from the
-- browser. No new table, column or privilege on a table: only functions, so the migration is
-- compatible with 1.2.x (B13). The rules of docs/adr/0038 apply to each of them: SECURITY
-- DEFINER, pinned search_path, executable by mercurio_app alone, the operator checked first,
-- ids made in SQL, the outcome returned as text.
--
-- None of them checks the operator's one-time code: the TOTP secret is encrypted with a key that
-- only the API has, so the API checks it before calling recovery, grant and revocation. The
-- boundary against whoever is not an operator stays here.
-- ===========================================================================================

-- A further company of a tenant, already normalized by the code (the rules of the tenant
-- administrator, phase 7). Works on a suspended tenant too: it is configuration, not work. The
-- tenant version does not change: a company is a row of its own, and the VAT number is unique in
-- the tenant. Outcome: OK, NOT_FOUND or VAT_EXISTS; the new company.
CREATE FUNCTION app_platform_add_company(
  p_tenant uuid, p_legal_name text, p_vat_number text, p_tax_code text, p_country text
)
  RETURNS TABLE (outcome text, company_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_company uuid := mercurio_uuid_v7();
BEGIN
  PERFORM mercurio_platform_assert_operator();
  PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::uuid; RETURN;
  END IF;
  BEGIN
    INSERT INTO public.companies (id, tenant_id, legal_name, vat_number, tax_code, country,
                                  updated_at)
    VALUES (v_company, p_tenant, p_legal_name, p_vat_number, p_tax_code, p_country, now());
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'VAT_EXISTS', NULL::uuid; RETURN;
  END;
  PERFORM mercurio_platform_audit(p_tenant, 'COMPANY_ADDED', 'company', v_company,
    jsonb_build_object('legalName', p_legal_name, 'vatNumber', p_vat_number));
  RETURN QUERY SELECT 'OK', v_company;
END
$$;

-- The person with exactly this email, with what a recovery needs to be decided: whether the
-- account is activated, whether they are an operator, when they last signed in, and where they
-- work (tenant and role, nothing else of the tenants). One person or null: never a list.
CREATE FUNCTION app_platform_find_person(p_email text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM mercurio_platform_assert_operator();
  RETURN (
    SELECT jsonb_build_object(
      'userId', u.id, 'name', u.name, 'email', u.email, 'status', u.status,
      'activated', EXISTS (SELECT 1 FROM public.credentials c WHERE c.user_id = u.id),
      'operator', EXISTS (SELECT 1 FROM public.platform_operators o
                          WHERE o.user_id = u.id AND o.revoked_at IS NULL),
      'lastSeenAt', (SELECT max(s.last_used_at) FROM public.sessions s WHERE s.user_id = u.id),
      'memberships', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'tenantId', t.id, 'tenantName', t.name, 'slug', t.slug,
                 'tenantStatus', t.status, 'role', m.role, 'customRole', r.name)
                 ORDER BY t.name, t.id)
        FROM public.memberships m
        JOIN public.tenants t ON t.id = m.tenant_id
        LEFT JOIN public.tenant_roles r ON r.id = m.custom_role_id
        WHERE m.user_id = u.id AND m.status = 'ACTIVE'), '[]'::jsonb)
    )
    FROM public.users u WHERE u.email = lower(btrim(p_email))
  );
END
$$;

-- A recovery code for an activated account (lost phone, recovery codes used up). The sessions of
-- the person close now, so whoever did not ask for it notices at once; password and
-- authenticator keep working until the code is used (app_activate_account then resets them).
-- Never for an operator (a compromised operator would take the others over) nor for oneself;
-- never for an account not activated yet (its administrator issues an activation code) or with
-- no active membership (no tenant would see the event). Written in the person's security events
-- with the reason, and in the audit log of each of their tenants without it.
-- Outcome: OK, NOT_FOUND, REASON_REQUIRED, SELF, IS_OPERATOR, NOT_ACTIVATED or NO_MEMBERSHIP.
CREATE FUNCTION app_platform_issue_recovery_code(
  p_user uuid, p_reason text, p_code_hash text, p_expires_at timestamptz
)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_reason text := btrim(p_reason);
  v_email text;
  v_sessions integer;
  v_member record;
BEGIN
  PERFORM mercurio_platform_assert_operator();
  IF v_reason IS NULL OR v_reason = '' THEN
    RETURN 'REASON_REQUIRED';
  END IF;
  -- Lock the person: a grant or a membership added meanwhile is seen.
  SELECT u.email INTO v_email FROM public.users u
  WHERE u.id = p_user AND u.status = 'ACTIVE' FOR UPDATE;
  IF v_email IS NULL THEN
    RETURN 'NOT_FOUND';
  END IF;
  IF p_user = app_user_id() THEN
    RETURN 'SELF';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_operators o
             WHERE o.user_id = p_user AND o.revoked_at IS NULL) THEN
    RETURN 'IS_OPERATOR';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.credentials c WHERE c.user_id = p_user) THEN
    RETURN 'NOT_ACTIVATED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships m
                 WHERE m.user_id = p_user AND m.status = 'ACTIVE') THEN
    RETURN 'NO_MEMBERSHIP';
  END IF;

  UPDATE public.sessions s SET revoked_at = now()
  WHERE s.user_id = p_user AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  DELETE FROM public.activation_tokens t WHERE t.user_id = p_user AND t.used_at IS NULL;
  INSERT INTO public.activation_tokens (id, user_id, token_hash, expires_at)
  VALUES (mercurio_uuid_v7(), p_user, p_code_hash, p_expires_at);

  INSERT INTO public.auth_events (id, user_id, type, details)
  VALUES (mercurio_uuid_v7(), p_user, 'ACCOUNT_RECOVERY_ISSUED',
          jsonb_build_object('by', app_user_id(), 'reason', v_reason,
                             'expiresAt', p_expires_at, 'sessions', v_sessions));
  FOR v_member IN
    SELECT m.id, m.tenant_id FROM public.memberships m
    WHERE m.user_id = p_user AND m.status = 'ACTIVE' ORDER BY m.tenant_id
  LOOP
    PERFORM mercurio_platform_audit(v_member.tenant_id, 'MEMBER_RECOVERY_ISSUED', 'membership',
      v_member.id, jsonb_build_object('email', v_email, 'expiresAt', p_expires_at));
  END LOOP;
  RETURN 'OK';
END
$$;

-- Every operator grant, open and revoked: the people operators work with, who have the same
-- powers. Newest first within each person. other_tenants tells whether a new activation code can
-- be issued (app_platform_issue_operator_code), as for the administrators of a tenant.
CREATE FUNCTION app_platform_list_operators()
  RETURNS TABLE (
    grant_id uuid, user_id uuid, name text, email text, activated boolean,
    other_tenants boolean, last_seen_at timestamptz, granted_at timestamptz, granted_by_name text,
    revoked_at timestamptz, revoked_by_name text, revoke_reason text
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM mercurio_platform_assert_operator();
  RETURN QUERY
    SELECT o.id, u.id, u.name, u.email,
           EXISTS (SELECT 1 FROM public.credentials c WHERE c.user_id = u.id),
           EXISTS (SELECT 1 FROM public.memberships m
                   WHERE m.user_id = u.id AND m.status = 'ACTIVE'),
           (SELECT max(s.last_used_at) FROM public.sessions s WHERE s.user_id = u.id),
           o.granted_at, g.name, o.revoked_at, r.name, o.revoke_reason
    FROM public.platform_operators o
    JOIN public.users u ON u.id = o.user_id
    LEFT JOIN public.users g ON g.id = o.granted_by
    LEFT JOIN public.users r ON r.id = o.revoked_by
    ORDER BY u.name, u.id, o.granted_at DESC;
END
$$;

-- Makes a person an operator. An unknown email becomes a new identity (a name is needed) with the
-- code whose hash is given; a known one keeps its account and gets no code. A person who works
-- for tenants becomes an operator only when p_confirm says the operator saw which ones.
-- Outcome: GRANTED, NAME_REQUIRED, USER_DISABLED, ALREADY_OPERATOR or NEEDS_CONFIRMATION (with
-- the tenants).
CREATE FUNCTION app_platform_grant_operator(
  p_email text, p_name text, p_confirm boolean, p_code_hash text, p_code_expires_at timestamptz
)
  RETURNS TABLE (outcome text, user_id uuid, identity_created boolean, tenants jsonb)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(btrim(p_email));
  v_person record;
  v_tenants jsonb;
BEGIN
  PERFORM mercurio_platform_assert_operator();
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.email = v_email)
     AND (p_name IS NULL OR btrim(p_name) = '') THEN
    RETURN QUERY SELECT 'NAME_REQUIRED', NULL::uuid, false, NULL::jsonb; RETURN;
  END IF;
  SELECT * INTO v_person FROM app_find_or_create_person(mercurio_uuid_v7(), v_email, p_name);
  IF v_person.status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'USER_DISABLED', v_person.user_id, false, NULL::jsonb; RETURN;
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = v_person.user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.platform_operators o
             WHERE o.user_id = v_person.user_id AND o.revoked_at IS NULL) THEN
    RETURN QUERY SELECT 'ALREADY_OPERATOR', v_person.user_id, false, NULL::jsonb; RETURN;
  END IF;
  v_tenants := (
    SELECT jsonb_agg(jsonb_build_object('name', t.name, 'slug', t.slug) ORDER BY t.name, t.id)
    FROM public.memberships m JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.user_id = v_person.user_id AND m.status = 'ACTIVE');
  IF v_tenants IS NOT NULL AND NOT p_confirm THEN
    RETURN QUERY SELECT 'NEEDS_CONFIRMATION', v_person.user_id, false, v_tenants; RETURN;
  END IF;

  INSERT INTO public.platform_operators (id, user_id, granted_by)
  VALUES (mercurio_uuid_v7(), v_person.user_id, app_user_id());
  INSERT INTO public.auth_events (id, user_id, type, details)
  VALUES (mercurio_uuid_v7(), v_person.user_id, 'OPERATOR_GRANTED',
          jsonb_build_object('by', app_user_id()));
  IF v_person.created THEN
    INSERT INTO public.activation_tokens (id, user_id, token_hash, expires_at)
    VALUES (mercurio_uuid_v7(), v_person.user_id, p_code_hash, p_code_expires_at);
    INSERT INTO public.auth_events (id, user_id, type, details)
    VALUES (mercurio_uuid_v7(), v_person.user_id, 'ACTIVATION_CODE_ISSUED',
            jsonb_build_object('by', app_user_id(), 'expiresAt', p_code_expires_at));
  END IF;
  RETURN QUERY SELECT 'GRANTED', v_person.user_id, v_person.created, v_tenants;
END
$$;

-- Closes the open grant of another operator, with a reason; the row stays as history. Every open
-- grant is locked before checking anything: two operators revoking each other at the same moment
-- are served one after the other, and the second is no longer an operator. With
-- p_close_sessions the person is signed out everywhere too (an account believed compromised).
-- Outcome: OK, REASON_REQUIRED, SELF, NOT_OPERATOR or LAST_OPERATOR.
CREATE FUNCTION app_platform_revoke_operator(
  p_user uuid, p_reason text, p_close_sessions boolean
)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
DECLARE
  v_reason text := btrim(p_reason);
  v_grant uuid;
  v_sessions integer;
BEGIN
  PERFORM mercurio_platform_assert_operator();
  IF v_reason IS NULL OR v_reason = '' THEN
    RETURN 'REASON_REQUIRED';
  END IF;
  IF p_user = app_user_id() THEN
    RETURN 'SELF';
  END IF;
  PERFORM 1 FROM public.platform_operators o WHERE o.revoked_at IS NULL ORDER BY o.id FOR UPDATE;
  -- Checked again under the lock: a concurrent revocation of the caller has now committed.
  PERFORM mercurio_platform_assert_operator();
  SELECT o.id INTO v_grant FROM public.platform_operators o
  WHERE o.user_id = p_user AND o.revoked_at IS NULL;
  IF v_grant IS NULL THEN
    RETURN 'NOT_OPERATOR';
  END IF;
  -- Cannot happen while the caller is an operator and not the target; kept as the last guard.
  IF NOT EXISTS (SELECT 1 FROM public.platform_operators o
                 WHERE o.revoked_at IS NULL AND o.id <> v_grant) THEN
    RETURN 'LAST_OPERATOR';
  END IF;

  UPDATE public.platform_operators o
  SET revoked_at = now(), revoked_by = app_user_id(), revoke_reason = v_reason
  WHERE o.id = v_grant;
  IF p_close_sessions THEN
    UPDATE public.sessions s SET revoked_at = now()
    WHERE s.user_id = p_user AND s.revoked_at IS NULL;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;
  END IF;
  INSERT INTO public.auth_events (id, user_id, type, details)
  VALUES (mercurio_uuid_v7(), p_user, 'OPERATOR_REVOKED',
          jsonb_build_object('by', app_user_id(), 'reason', v_reason,
                             'sessionsClosed', p_close_sessions, 'sessions', v_sessions));
  RETURN 'OK';
END
$$;

-- A new activation code for an operator who has not activated their account yet, with the
-- conditions of the other codes (docs/adr/0037): never for an activated account (recovering an
-- operator stays on the terminal), never for someone who works for tenants.
-- Outcome: OK, NOT_OPERATOR, ALREADY_ACTIVATED or OTHER_TENANTS.
CREATE FUNCTION app_platform_issue_operator_code(
  p_user uuid, p_code_hash text, p_expires_at timestamptz
)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM mercurio_platform_assert_operator();
  PERFORM 1 FROM public.users u WHERE u.id = p_user AND u.status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.platform_operators o
                              WHERE o.user_id = p_user AND o.revoked_at IS NULL) THEN
    RETURN 'NOT_OPERATOR';
  END IF;
  IF EXISTS (SELECT 1 FROM public.credentials c WHERE c.user_id = p_user) THEN
    RETURN 'ALREADY_ACTIVATED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memberships m
             WHERE m.user_id = p_user AND m.status = 'ACTIVE') THEN
    RETURN 'OTHER_TENANTS';
  END IF;
  DELETE FROM public.activation_tokens t WHERE t.user_id = p_user AND t.used_at IS NULL;
  INSERT INTO public.activation_tokens (id, user_id, token_hash, expires_at)
  VALUES (mercurio_uuid_v7(), p_user, p_code_hash, p_expires_at);
  INSERT INTO public.auth_events (id, user_id, type, details)
  VALUES (mercurio_uuid_v7(), p_user, 'ACTIVATION_CODE_ISSUED',
          jsonb_build_object('by', app_user_id(), 'expiresAt', p_expires_at));
  RETURN 'OK';
END
$$;

REVOKE EXECUTE ON FUNCTION app_platform_add_company(uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_find_person(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_issue_recovery_code(uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_list_operators() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_grant_operator(text, text, boolean, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_revoke_operator(uuid, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_platform_issue_operator_code(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_add_company(uuid, text, text, text, text) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_find_person(text) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_issue_recovery_code(uuid, text, text, timestamptz) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_list_operators() TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_grant_operator(text, text, boolean, text, timestamptz) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_revoke_operator(uuid, text, boolean) TO mercurio_app;
GRANT EXECUTE ON FUNCTION app_platform_issue_operator_code(uuid, text, timestamptz) TO mercurio_app;
