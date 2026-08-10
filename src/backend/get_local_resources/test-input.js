console.log(
    JSON.stringify({
        version: "2.0",
        rawPath: "/local-resources",
        requestContext: {
            http: {
                method: "GET",
                path: "/local-resources",
            },
        },
        rawQueryString: `is-test=true&session-id=${crypto.randomUUID()}&device-id=${crypto.randomUUID()}&zip-code=07102&max-radius=${25 * 1609}`
    }),
);
