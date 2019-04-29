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

 /**
  * 导出运行时异常类
  */
export class RuntimeException {

    /**
     * 构造函数
     * @param {构造参数-异常信息} message 
     */
    constructor(message) {
        // 保存异常信息
        this._message = message;
    }

    /**
     * 获取类名称
     */
    get name() {
        return 'RuntimeException';
    }

    /**
     * 获取异常消息
     */
    get message() {
        return this._message;
    }

    /**
     * 重写toString方法：
     * 返回类名称+异常消息
     */
    toString() {
        return this.name + ': ' + this.message;
    }

}

/**
 * 导出非法状态异常类，该类集成字运行时异常类
 */
export class IllegalStateException extends RuntimeException {

    /**
     * 构造函数
     * @param {构造参数-异常信息} message 
     */
    constructor(message) {
        super(message);
    }

    /**
     * 重写类名称方法
     */
    get name() {
        return 'IllegalStateException';
    }

}

/**
 * 导出无效参数异常类，该类集成自运行时异常类 
 */
export class InvalidArgumentException extends RuntimeException {

    /**
     * 构造函数
     * @param {构造参数-异常信息} message 
     */
    constructor(message) {
        super(message);
    }

    /**
     * 重写获取类名称方法
     */
    get name() {
        return 'InvalidArgumentException';
    }

}

/**
 * 导出未实现异常类，该类继承自运行时类
 */
export class NotImplementedException extends RuntimeException {

    /**
     * 构造函数
     * @param {构造参数-异常信息} message 
     */
    constructor(message) {
        super(message);
    }

    /**
     * 重写获取类名称方法
     */
    get name() {
        return 'NotImplementedException';
    }

}
