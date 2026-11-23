export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check platform health */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/federation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve a federation name or address */
        get: operations["getFederation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lookup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Look up registered usernames */
        get: operations["lookupUsernames"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List tags */
        get: operations["listTags"];
        put?: never;
        /**
         * Create a tag
         * @description Registers a new tag (username). If the name was soft-deleted and its reservation window has not expired, registration is rejected with `409 Conflict`. Once the window expires the name is reusable.
         */
        post: operations["createTag"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tags/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Tag identifier */
                id: components["parameters"]["TagIdParam"];
            };
            cookie?: never;
        };
        /** Get a tag by id */
        get: operations["getTag"];
        put?: never;
        post?: never;
        /**
         * Soft-delete a tag
         * @description Soft-deletes the tag and starts the reservation window (`SOFT_DELETE_RESERVATION_DAYS`, default 30 days) during which the name cannot be reused. The transition is transactional; concurrent deletes/restores/registrations cannot create multiple owners.
         */
        delete: operations["deleteTag"];
        options?: never;
        head?: never;
        /** Update a tag */
        patch: operations["updateTag"];
        trace?: never;
    };
    "/api/tags/{id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Tag identifier */
                id: components["parameters"]["TagIdParam"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore a soft-deleted tag
         * @description Restores a soft-deleted tag within its reservation window. Requires the original owner's authenticated identity and the `deletedAt` value observed at deletion time as restoration proof. Fails with `409 Conflict` on stale/already-restored state and `410 Gone` after the reservation window expires.
         */
        post: operations["restoreTag"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/addresses/{address}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get tags for a Stellar address */
        get: operations["getAddressTags"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List activity feed entries */
        get: operations["listActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get platform statistics
         * @description Returns aggregate statistics served from the refreshable reporting read model. The response includes the source watermark and refresh status so clients can reason about staleness. Reporting refreshes run asynchronously and never block payment writes.
         */
        get: operations["getStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get admin statistics */
        get: operations["getAdminStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List published API contract versions
         * @description Returns the versioned client contracts the server still supports, including deprecation windows. Clients and the backward-compatibility test suite use this to pin the contract they validate against.
         */
        get: operations["listApiVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/stats/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get reporting read model refresh status
         * @description Returns the current refresh status and source watermark of the reporting read model.
         */
        get: operations["getStatsRefreshStatus"];
        put?: never;
        /**
         * Trigger a reporting read model refresh
         * @description Enqueues an asynchronous refresh of the reporting read model. The refresh runs decoupled from the payment write path and records the source watermark on completion. Returns the current refresh status.
         */
        post: operations["refreshStats"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        TagInput: {
            username: string;
            address: string;
        };
        Tag: {
            id: string;
            username: string;
            address: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            deletedAt?: string;
        };
        TagList: {
            data: components["schemas"]["Tag"][];
            totalCount?: number;
            totalPages?: number;
            currentPage?: number;
        };
        ActivityList: {
            data: {
                [key: string]: unknown;
            }[];
            nextCursor?: string;
            hasMore?: boolean;
        };
        /** @description Aggregate metrics and the refresh watermark for the reporting read model. */
        Stats: {
            [key: string]: unknown;
        };
        StatsRefreshStatus: {
            /** @enum {string} */
            status: "idle" | "refreshing" | "succeeded" | "failed";
            /** Format: date-time */
            sourceWatermark?: string;
            /** Format: date-time */
            startedAt?: string;
            /** Format: date-time */
            completedAt?: string;
            error?: string;
        };
        Error: {
            /** @constant */
            success: false;
            error: {
                /** @enum {string} */
                code: "INVALID_INPUT" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "GONE" | "CONFLICT" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "VALIDATION_FAILED" | "RATE_LIMITED" | "INTERNAL_ERROR" | "UPSTREAM_ERROR" | "SERVICE_UNAVAILABLE";
                message: string;
                retryable: boolean;
                details?: {
                    field: string;
                    message: string;
                }[];
            };
            correlation_id?: string;
            reference_id?: string;
        };
        HealthStatus: {
            /** @enum {string} */
            status: "UP";
            /** Format: date-time */
            timestamp: string;
            /** @enum {string} */
            database: "up";
            /** @enum {string} */
            redis: "up" | "not configured";
            /** @enum {string} */
            horizon: "up";
        };
        FederationEntry: {
            stellar_address: string;
            account_id: string;
            memo_type?: string;
            memo?: string;
        };
        LookupResult: {
            username?: string;
            address?: string;
            primary?: string;
            usernames?: string[];
            data?: {
                [key: string]: unknown;
            }[];
            totalCount?: number;
            totalPages?: number;
            currentPage?: number;
        };
        RestoreTagInput: {
            /**
             * Format: date-time
             * @description The `deletedAt` value observed at deletion time; used as restoration proof. A mismatch is rejected with 409 Conflict.
             */
            deletedAt: string;
        };
        /** @description Versioned client contract metadata used by the backward-compatibility test suite. */
        ApiVersion: {
            /** @description Semantic version of the published API contract. */
            version: string;
            /** @description Whether the version is still supported for existing clients. */
            status: "active" | "deprecated" | "sunset";
            /** Format: date-time */
            releasedAt: string;
            /** Format: date-time */
            deprecatedAt?: string;
            /** Format: date-time */
            sunsetAt?: string;
            /** @description Human-readable migration guidance for clients on this version. */
            deprecationNotice?: string;
        };
        ApiVersionList: {
            data: components["schemas"]["ApiVersion"][];
        };
    };
    responses: {
        /** @description A standardized API error */
        ApiErrorResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Invalid request */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Authentication required or invalid credentials */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Authenticated but not permitted (e.g. not the original owner) */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Resource not found */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description State transition conflict (name reserved, stale restore proof, or concurrent transition lost) */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Reservation window expired; the tag can no longer be restored */
        Gone: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        /** @description Page number (1-based) */
        PageParam: number;
        /** @description Maximum number of items per page */
        LimitParam: number;
        /** @description Opaque cursor for pagination */
        CursorParam: string;
        /** @description Tag identifier */
        TagIdParam: string;
        /** @description Stellar account address */
        AddressParam: string;
        /** @description Token identifier (asset code or contract address) */
        TokenParam: string;
        /** @description Published client contract version to validate against (e.g. `2024-01-01`). */
        ApiVersionParam: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All configured dependencies are healthy */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthStatus"];
                };
            };
            503: components["responses"]["ApiErrorResponse"];
        };
    };
    getFederation: {
        parameters: {
            query: {
                q: string;
                type?: "id" | "name";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resolved federation identity */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationEntry"];
                };
            };
            400: components["responses"]["ApiErrorResponse"];
            404: components["responses"]["ApiErrorResponse"];
            500: components["responses"]["ApiErrorResponse"];
            502: components["responses"]["ApiErrorResponse"];
            503: components["responses"]["ApiErrorResponse"];
        };
    };
    lookupUsernames: {
        parameters: {
            query?: {
                address?: string;
                search?: string;
                all?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Lookup result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LookupResult"];
                };
            };
            400: components["responses"]["ApiErrorResponse"];
            404: components["responses"]["ApiErrorResponse"];
            500: components["responses"]["ApiErrorResponse"];
            503: components["responses"]["ApiErrorResponse"];
        };
    };
    listTags: {
        parameters: {
            query?: {
                /** @description Page number (1-based) */
                page?: components["parameters"]["PageParam"];
                /** @description Maximum number of items per page */
                limit?: components["parameters"]["LimitParam"];
                /** @description Search query */
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A paginated list of tags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TagList"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    createTag: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TagInput"];
            };
        };
        responses: {
            /** @description Tag created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Tag"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
        };
    };
    getTag: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Tag identifier */
                id: components["parameters"]["TagIdParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tag details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Tag"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    deleteTag: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Tag identifier */
                id: components["parameters"]["TagIdParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tag soft-deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    updateTag: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Tag identifier */
                id: components["parameters"]["TagIdParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TagInput"];
            };
        };
        responses: {
            /** @description Updated tag */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Tag"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    restoreTag: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Tag identifier */
                id: components["parameters"]["TagIdParam"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RestoreTagInput"];
            };
        };
        responses: {
            /** @description Tag restored */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Tag"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            410: components["responses"]["Gone"];
        };
    };
    getAddressTags: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Stellar account address */
                address: components["parameters"]["AddressParam"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tags associated with the address */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TagList"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    listActivity: {
        parameters: {
            query?: {
                /** @description Opaque cursor for pagination */
                cursor?: components["parameters"]["CursorParam"];
                /** @description Maximum number of items per page */
                limit?: components["parameters"]["LimitParam"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cursor-paginated activity feed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActivityList"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    getStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Aggregate platform statistics from the reporting read model */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Stats"];
                };
            };
        };
    };
    getAdminStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Administrative statistics */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Stats"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    listApiVersions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Published API contract versions and their deprecation windows */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiVersionList"];
                };
            };
        };
    };
    getStatsRefreshStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current refresh status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StatsRefreshStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    refreshStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Refresh accepted and running asynchronously */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StatsRefreshStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description A refresh is already in progress */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StatsRefreshStatus"];
                };
            };
        };
    };
}
