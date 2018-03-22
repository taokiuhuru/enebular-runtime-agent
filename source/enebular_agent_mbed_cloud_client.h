
#ifndef ENEBULAR_AGENT_MBED_CLOUD_CLIENT_H
#define ENEBULAR_AGENT_MBED_CLOUD_CLIENT_H

#include "mbed-cloud-client/MbedCloudClient.h"
#include "mbed-client/m2mobject.h"

typedef FP0<void> ConnectionStateCallback;
typedef FP2<void,const char *,const char *> AgentManagerMsgCallback;

/**
 * Todo:
 *  - Standard device/security objects/resources
 */

class EnebularAgentMbedCloudClient {

public:

    /**
     * Constructor
     */
    EnebularAgentMbedCloudClient();

    /**
     * Deconstructor
     */
    ~EnebularAgentMbedCloudClient();

    /**
     * Sets up the client ready for connection.
     */
    bool setup();

    // void cleanup();

    /**
     * Connect to Mbed Cloud.
     * 
     * @param iface A handler to the network interface on mbedOS, can be NULL on
     *              other platforms.
     */
    bool connect(void *iface);

    void disconnect();

    bool is_connected();

    const char *get_device_id(void);

    const char *get_endpoint_name(void);

    void register_connection_state_callback(ConnectionStateCallback cb);

    void register_agent_manager_msg_callback(AgentManagerMsgCallback cb);

    // todo: update handler reg

private:

    MbedCloudClient _cloud_client;
    M2MObjectList _object_list;
    vector<ConnectionStateCallback> _connection_state_callbacks;
    vector<AgentManagerMsgCallback> _agent_man_msg_callbacks;
    bool _registered;

    M2MResource *_deploy_flow_download_url_res;
    M2MResource *_register_connection_id_res;
    M2MResource *_register_device_id_res;
    M2MResource *_register_auth_request_url_res;
    M2MResource *_register_agent_manager_base_url_res;
    M2MResource *_update_auth_access_token_res;
    M2MResource *_update_auth_id_token_res;
    M2MResource *_update_auth_state_res;

    unsigned long long _register_connection_id_time;
    unsigned long long _register_device_id_time;
    unsigned long long _register_auth_request_url_time;
    unsigned long long _register_agent_manager_base_url_time;
    unsigned long long _update_auth_access_token_time;
    unsigned long long _update_auth_id_token_time;
    unsigned long long _update_auth_state_time;

    void client_registered();
    void client_registration_updated();
    void client_unregistered();
    void client_error(int error_code);

    void setup_objects();

    M2MResource *add_resource(
        uint16_t object_id,
        uint16_t instance_id,
        uint16_t resource_id,
        const char *resource_type,
        M2MResourceInstance::ResourceType data_type,
        M2MBase::Operation operations,
        const char *value,
        bool observable,
        value_updated_callback value_updated_cb,
        execute_callback execute_cb);

    // PUT/GET
    M2MResource *add_rw_resource(
        uint16_t object_id,
        uint16_t instance_id,
        uint16_t resource_id,
        const char *resource_type,
        M2MResourceInstance::ResourceType data_type,
        const char *value,
        bool observable,
        value_updated_callback value_updated_cb);

    // POST
    M2MResource *add_execute_resource(
        uint16_t object_id,
        uint16_t instance_id,
        uint16_t resource_id,
        const char *resource_type,
        execute_callback execute_cb);

    void deploy_flow_download_url_cb(const char *name);
    void register_connection_id_cb(const char *name);
    void register_device_id_cb(const char *name);
    void register_auth_request_url_cb(const char *name);
    void register_agent_manager_base_url_cb(const char *name);
    void update_auth_access_token_cb(const char *name);
    void update_auth_id_token_cb(const char *name);
    void update_auth_state_cb(const char *name);

    //void example_execute_function(void * argument);

    void process_deploy_flow_update(void);
    void process_register_update(void);
    void process_update_auth_update(void);

    void notify_conntection_state(void);
    void notify_agent_man_msg(const char *type, const char *content);

};

#endif // ENEBULAR_AGENT_MBED_CLOUD_CLIENT_H
