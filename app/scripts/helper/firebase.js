/**
 * Copyright 2016 Google Inc. All rights reserved.
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
'use strict';

window.IOWA = window.IOWA || {};

/**
 * Firebase for the I/O Web App.
 */
class IOFirebase {

  constructor() {
    /**
     * Currently authorized Firebase Database shard.
     * @type {Firebase}
     */
    this.firebaseRef = null;

    /**
     * Offset between the local clock and the Firebase servers clock. This is used to replay offline
     * operations accurately.
     * @type {number}
     */
    this.clockOffset = 0;

    // Disconnect Firebase while the focus is off the page to save battery.
    if (typeof document.hidden !== 'undefined') {
      document.addEventListener('visibilitychange',
          () => document.hidden ? IOFirebase.goOffline() : IOFirebase.goOnline());
    }
  }

  /**
   * List of Firebase Database shards.
   * @static
   * @constant
   * @type {Array.<string>}
   */
  static get FIREBASE_DATABASES_URL() {
    return ['https://iowa-2016-dev.firebaseio.com/'];
  }

  /**
   * Selects the correct Firebase Database shard for the given user.
   *
   * @static
   * @private
   * @param {string} userId The ID of the signed-in Google user.
   * @return {string} The URL of the Firebase Database shard.
   */
  static _selectShard(userId) {
    let shardIndex = parseInt(crc32(userId), 16) % IOFirebase.FIREBASE_DATABASES_URL.length;
    return IOFirebase.FIREBASE_DATABASES_URL[shardIndex];
  }

  /**
   * Authorizes the given user to the correct Firebase Database shard.
   *
   * @param {string} userId The ID of the signed-in Google user.
   * @param {string} accessToken The accessToken of the signed-in Google user.
   */
  auth(userId, accessToken) {
    let firebaseShardUrl = IOFirebase._selectShard(userId);
    console.log('Chose the following Firebase Database Shard:', firebaseShardUrl);
    this.firebaseRef = new Firebase(firebaseShardUrl);
    this.firebaseRef.authWithOAuthToken('google', accessToken, error => {
      if (error) {
        IOWA.Analytics.trackError('this.firebaseRef.authWithOAuthToken(...)', error);
        debugLog('Login to Firebase Failed!', error);
      } else {
        this._bumpLastActivityTimestamp();
        IOWA.Analytics.trackEvent('login', 'success', firebaseShardUrl);
        debugLog('Authenticated successfully to Firebase shard', firebaseShardUrl);
      }
    });

    // Update the clock offset.
    this._updateClockOffset();
  }

  /**
   * Unauthorizes Firebase.
   */
  unAuth() {
    if (this.firebaseRef) {
      // Make sure to detach any callbacks.
      let userId = this.firebaseRef.getAuth().uid;
      this.firebaseRef.child(`users/${userId}/my_sessions`).off();
      this.firebaseRef.child(`users/${userId}/feedback`).off();
      // Unauthorize the Firebase reference.
      this.firebaseRef.unauth();
      debugLog('Unauthorized Firebase');
      this.firebaseRef = null;
    }
  }

  /**
   * Updates the offset between the local clock and the Firebase servers clock.
   * @private
   */
  _updateClockOffset() {
    if (this.firebaseRef) {
      // Retrieve the offset between the local clock and Firebase's clock for offline operations.
      let offsetRef = this.firebaseRef.child('/.info/serverTimeOffset');
      offsetRef.once('value', snap => {
        this.clockOffset = snap.val();
        debugLog('Updated clock offset to', this.clockOffset, 'ms');
      });
    }
  }

  /**
   * Update the user's last activity timestamp and make sure it will be updated when the user
   * disconnects.
   *
   * @private
   * @return {Promise} Promise to track completion.
   */
  _bumpLastActivityTimestamp() {
    let userId = this.firebaseRef.getAuth().uid;
    this.firebaseRef.child(`users/${userId}/last_activity_timestamp`).onDisconnect().set(
      Firebase.ServerValue.TIMESTAMP);
    return this._setFirebaseUserData('last_activity_timestamp', Firebase.ServerValue.TIMESTAMP);
  }

  /**
   * Disconnect Firebase.
   * @static
   */
  static goOffline() {
    Firebase.goOffline();
    debugLog('Firebase went offline.');
  }

  /**
   * Re-connect to the Firebase backend.
   * @static
   */
  static goOnline() {
    Firebase.goOnline();
    debugLog('Firebase back online!');
  }

  /**
   * Register to get updates on bookmarked sessions. This should also be used to get the initial
   * list of bookmarked sessions.
   *
   * @param {IOFirebase~updateCallback} callback A callback function that will be called with the
   *     data for each sessions when they get updated.
   */
  registerToSessionUpdates(callback) {
    this._registerToUpdates('my_sessions', callback);
  }

  /**
   * Register to get updates on saved session feedback. This should also be used to get the initial
   * list of saved session feedback.
   *
   * @param {IOFirebase~updateCallback} callback A callback function that will be called with the
   *     data for each saved session feedback when they get updated.
   */
  registerToFeedbackUpdates(callback) {
    this._registerToUpdates('feedback', callback);
  }

  /**
   * Register to get updates on the given user data attribute.
   *
   * @private
   * @param {string} attribute The Firebase user data attribute for which updated will trigger the
   *     callback.
   * @param {IOFirebase~updateCallback} callback A callback function that will be called for each
   *     updates/deletion/addition of an item in the given attribute.
   */
  _registerToUpdates(attribute, callback) {
    if (this.isAuthed()) {
      let userId = this.firebaseRef.getAuth().uid;
      let ref = this.firebaseRef.child(`users/${userId}/${attribute}`);

      ref.on('child_added', dataSnapshot => callback(dataSnapshot.key(), dataSnapshot.val()));
      ref.on('child_changed', dataSnapshot => callback(dataSnapshot.key(), dataSnapshot.val()));
      ref.on('child_removed', dataSnapshot => callback(dataSnapshot.key(), null));
    } else {
      debugLog('Trying to subscribe to Firebase while not authorized.');
    }
  }

  /**
   * Callback used to notify updates.
   *
   * @callback IOFirebase~updateCallback
   * @param {string} key The key of the element that was updated/added/deleted.
   * @param {string|null} value The value given to the updated element. `null` if the element was
   *     deleted.
   */

  /**
   * Adds or remove the given session to the user's schedule.
   *
   * @param {string} sessionUUID The session's UUID.
   * @param {boolean} bookmarked `true` if the user has bookmarked the session.
   * @param {number=} timestamp The timestamp when the session was added to the schedule. Use this to
   *     replay offline changes. If not provided the current timestamp will be used.
   * @return {Promise} Promise to track completion.
   */
  toggleSession(sessionUUID, bookmarked, timestamp) {
    let value = {};
    value[sessionUUID] = {
      timestamp: timestamp ? timestamp + this.clockOffset : Firebase.ServerValue.TIMESTAMP,
      bookmarked: bookmarked
    };
    return this._updateFirebaseUserData('my_sessions', value);
  }

  /**
   * Mark that user has provided feedback for a session.
   *
   * @param {string} sessionUUID The session's UUID.
   * @param {number=} timestamp The timestamp when the feedback was provided. Use this to replay
   *     offline changes. If not provided the current timestamp will be used.
   * @return {Promise} Promise to track completion.
   */
  markSessionRated(sessionUUID, timestamp) {
    let value = {};
    value[sessionUUID] = {
      timestamp: timestamp ? timestamp + this.clockOffset : Firebase.ServerValue.TIMESTAMP
    };
    return this._updateFirebaseUserData('feedback', value);
  }

  /**
   * Mark the given video as viewed by the user.
   *
   * @param {string} videoId The Youtube Video ID.
   * @param {number=} timestamp The timestamp when the video was viewed. Use this to replay offline
   *     changes. If not provided the current timestamp will be used.
   * @return {Promise} Promise to track completion.
   */
  markVideoAsViewed(videoId, timestamp) {
    let value = {};
    value[videoId] = timestamp ? timestamp + this.clockOffset : Firebase.ServerValue.TIMESTAMP;
    return this._updateFirebaseUserData('viewed_videos', value);
  }

  /**
   * Adds the GCM subscription ID provided by the browser.
   *
   * @param {string} gcmId The GCM Subscription ID.
   * @return {Promise} Promise to track completion.
   */
  addGcmId(gcmId) {
    let value = {};
    value[gcmId] = true;
    return this._updateFirebaseUserData('gcm_ids', value);
  }

  /**
   * Update the given attribute of Firebase User data to the given value.
   *
   * @private
   * @param {string} attribute The attribute to update in the user's data.
   * @param {Object} value The value to give to the attribute.
   * @return {Promise} Promise to track completion.
   */
  _updateFirebaseUserData(attribute, value) {
    if (this.isAuthed()) {
      let userId = this.firebaseRef.getAuth().uid;
      let ref = this.firebaseRef.child(`users/${userId}/${attribute}`);
      return ref.update(value, error => {
        if (error) {
          debugLog(`Error writing to Firebase data "${userId}/${attribute}":`, value, error);
        } else {
          debugLog(`Successfully updated Firebase data "${userId}/${attribute}":`, value);
        }
      });
    }

    debugLog('Trying to write to Firebase while not authorized.');
  }

  /**
   * Sets the given attribute of Firebase user data to the given value.
   *
   * @private
   * @param {string} attribute The attribute to set in the user's data.
   * @param {string|number|Object} value The value to give to the attribute.
   * @return {Promise} Promise to track completion.
   */
  _setFirebaseUserData(attribute, value) {
    if (this.isAuthed()) {
      let userId = this.firebaseRef.getAuth().uid;
      let ref = this.firebaseRef.child(`users/${userId}/${attribute}`);
      return ref.set(value, error => {
        if (error) {
          debugLog(`Error writing to Firebase data "${userId}/${attribute}":`, value, error);
        } else {
          debugLog(`Successfully updated Firebase data "${userId}/${attribute}":`, value);
        }
      });
    }

    debugLog('Trying to write to Firebase while not authorized.');
  }

  /**
   * Returns `true` if a user has authorized to Firebase.
   *
   * @return {boolean} `true` if a user has authorized to Firebase.
   */
  isAuthed() {
    return this.firebaseRef && this.firebaseRef.getAuth();
  }
}

IOWA.IOFirebase = IOWA.IOFirebase || new IOFirebase();