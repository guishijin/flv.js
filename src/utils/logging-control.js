/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import EventEmitter from 'events';
import Log from './logger.js';

/**
 * 日志控制类
 */
class LoggingControl {

    /**
     * 获取强制全局日志标志
     */
    static get forceGlobalTag() {
        return Log.FORCE_GLOBAL_TAG;
    }

    /**
     * 设置强制全局日志标志
     */
    static set forceGlobalTag(enable) {
        Log.FORCE_GLOBAL_TAG = enable;
        LoggingControl._notifyChange();
    }

    /**
     * 获取全局日志标志
     */
    static get globalTag() {
        return Log.GLOBAL_TAG;
    }

    /**
     * 设置全局日志标志
     */
    static set globalTag(tag) {
        Log.GLOBAL_TAG = tag;
        LoggingControl._notifyChange();
    }

    /**
     * 获取日志使能配置
     */
    static get enableAll() {
        return Log.ENABLE_VERBOSE
            && Log.ENABLE_DEBUG
            && Log.ENABLE_INFO
            && Log.ENABLE_WARN
            && Log.ENABLE_ERROR;
    }

    /**
     * 设置日志使能配置
     */
    static set enableAll(enable) {
        Log.ENABLE_VERBOSE = enable;
        Log.ENABLE_DEBUG = enable;
        Log.ENABLE_INFO = enable;
        Log.ENABLE_WARN = enable;
        Log.ENABLE_ERROR = enable;
        LoggingControl._notifyChange();
    }

    /**
     * 获取日志DEBUG使能标志
     */
    static get enableDebug() {
        return Log.ENABLE_DEBUG;
    }

    /**
     * 设置日志DEBUF使能标志
     */
    static set enableDebug(enable) {
        Log.ENABLE_DEBUG = enable;
        LoggingControl._notifyChange();
    }

    /**
     * 获取日志详细信息使能标志
     */
    static get enableVerbose() {
        return Log.ENABLE_VERBOSE;
    }

    /**
     * 设置日志详细信息使能标志
     */
    static set enableVerbose(enable) {
        Log.ENABLE_VERBOSE = enable;
        LoggingControl._notifyChange();
    }

    /**
     * 获取日志运行信息使能标志
     */
    static get enableInfo() {
        return Log.ENABLE_INFO;
    }

    /**
     * 设置日志运行信息使能标志
     */
    static set enableInfo(enable) {
        Log.ENABLE_INFO = enable;
        LoggingControl._notifyChange();
    }

    /**
     * 获取日志警告信息使能标志
     */
    static get enableWarn() {
        return Log.ENABLE_WARN;
    }

    /**
     * 设置日志警告信息使能标志
     */
    static set enableWarn(enable) {
        Log.ENABLE_WARN = enable;
        LoggingControl._notifyChange();
    }

    /**
     * 获取日志错误信息使能标志
     */
    static get enableError() {
        return Log.ENABLE_ERROR;
    }

    /**
     * 设置日志错误信息使能标志
     */
    static set enableError(enable) {
        Log.ENABLE_ERROR = enable;
        LoggingControl._notifyChange();
    }

    /**
     * 获取日志所有配置
     */
    static getConfig() {
        return {
            globalTag: Log.GLOBAL_TAG,
            forceGlobalTag: Log.FORCE_GLOBAL_TAG,
            enableVerbose: Log.ENABLE_VERBOSE,
            enableDebug: Log.ENABLE_DEBUG,
            enableInfo: Log.ENABLE_INFO,
            enableWarn: Log.ENABLE_WARN,
            enableError: Log.ENABLE_ERROR,
            enableCallback: Log.ENABLE_CALLBACK
        };
    }

    /**
     * 应用日志所有配置
     * @param {日志所有配置} config 
     */
    static applyConfig(config) {
        Log.GLOBAL_TAG = config.globalTag;
        Log.FORCE_GLOBAL_TAG = config.forceGlobalTag;
        Log.ENABLE_VERBOSE = config.enableVerbose;
        Log.ENABLE_DEBUG = config.enableDebug;
        Log.ENABLE_INFO = config.enableInfo;
        Log.ENABLE_WARN = config.enableWarn;
        Log.ENABLE_ERROR = config.enableError;
        Log.ENABLE_CALLBACK = config.enableCallback;
    }

    /**
     * 通知日志配置发生变化
     */
    static _notifyChange() {
        let emitter = LoggingControl.emitter;

        if (emitter.listenerCount('change') > 0) {
            let config = LoggingControl.getConfig();
            emitter.emit('change', config);
        }
    }

    /**
     * 注册配置变化监听器
     * @param {配置变化监听器} listener 
     */
    static registerListener(listener) {
        LoggingControl.emitter.addListener('change', listener);
    }

    /**
     * 移除配置变化监听器
     * @param {配置变化监听器} listener 
     */
    static removeListener(listener) {
        LoggingControl.emitter.removeListener('change', listener);
    }

    /**
     * 添加日志监听器
     * @param {日志监听器} listener 
     */
    static addLogListener(listener) {
        Log.emitter.addListener('log', listener);
        if (Log.emitter.listenerCount('log') > 0) {
            Log.ENABLE_CALLBACK = true;
            LoggingControl._notifyChange();
        }
    }

    /**
     * 移除日志监听器
     * @param {日志监听器} listener 
     */
    static removeLogListener(listener) {
        Log.emitter.removeListener('log', listener);
        if (Log.emitter.listenerCount('log') === 0) {
            Log.ENABLE_CALLBACK = false;
            LoggingControl._notifyChange();
        }
    }

}

// 初始化日志控制器的事件发射器
LoggingControl.emitter = new EventEmitter();

/**
 * 导出日志控制类
 */
export default LoggingControl;