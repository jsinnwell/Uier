exports.shared = {
    // Path that should be allowed by the CORS request
    client_url: "https://ui-test-service.herokuapp.com/",
    // Path and port to the Server
    server_url: "https://ui-test-service.herokuapp.com/",
    server_port: 8081,
    // Session secret for cookies
    server_session_secret: "test" + process.env.COMPUTERNAME + process.env.PATH,
    // Secret for the Runner to authenticate against the Server
    runner_secret: "test" + process.env.COMPUTERNAME + process.env.PATH
}
