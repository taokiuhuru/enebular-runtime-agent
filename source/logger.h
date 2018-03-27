
#ifndef LOGGER_H
#define LOGGER_H

#include <pthread.h>
#include "enebular_agent_interface.h"

enum LogLevel {
    DEBUG   = 0,
    INFO    = 1,
    ERROR   = 2
};

class Logger {

public:

    static Logger *get_instance();

    void set_agent_interface(EnebularAgentInterface *agent);

    void set_level(LogLevel level);

    void enable_console(bool enable);

    /**
     * Log to all destinations (both agent and console).
     *
     * This is not thread-safe (can only be called from the main thread).
     */
    void log(LogLevel level, const char *fmt, ...);

    /**
     * Log to only the console.
     *
     * This is thread-safe (can be called from any thread).
     */
    void log_console(LogLevel level, const char *fmt, ...);

private:

    static Logger *_instance;
    LogLevel _level;
    bool _console_enabled;
    EnebularAgentInterface *_agent;
    pthread_mutex_t _lock;

    Logger();
    void out_console(LogLevel level, const char *msg);
    void out_agent(LogLevel level, const char *msg);

};

#endif // LOGGER_H
